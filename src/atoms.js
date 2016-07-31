import {Track} from 'av';

// lookup table for atom handlers
export const atoms = {};

// ensure an atom is defined, and set the given key
function ensure(name, key, val) {
  if (!atoms[name]) {
    atoms[name] = {};
  }
  
  atoms[name][key] = val;
}

// declare a function to be used for parsing a given atom name
function atom(name, fn) {
  let c = [];
  for (let container of name.split('.').slice(0, -1)) {
    c.push(container);
    ensure(c.join('.'), 'container', true);
  }

  ensure(name, 'fn', fn);
}

// declare a function to be called after parsing of an atom and all sub-atoms has completed
function after(name, fn) {
  ensure(name, 'after', fn);
}

atom('moov.trak', function() {
  this.track = new Track;
});

atom('moov.trak.tkhd', function() {
  this.stream.advance(4); // version and flags

  this.stream.advance(8); // creation and modification time
  this.track.id = this.stream.readUInt32();

  this.stream.advance(this.len - 16);
});

// https://developer.apple.com/library/mac/documentation/QuickTime/QTFF/QTFFChap3/qtff3.html#//apple_ref/doc/uid/TP40000939-CH205-75770
const TRACK_TYPES = {
  vide: Track.VIDEO,
  soun: Track.AUDIO,
  sbtl: Track.SUBTITLE,
  text: Track.TEXT
};

atom('moov.trak.mdia.hdlr', function() {
  this.stream.advance(4); // version and flags

  this.stream.advance(4); // component type
  this.track.type = TRACK_TYPES[this.stream.readString(4)];

  this.stream.advance(12); // component manufacturer, flags, and mask
  this.stream.advance(this.len - 24); // component name
});

atom('moov.trak.mdia.mdhd', function() {
  this.stream.advance(4); // version and flags
  this.stream.advance(8); // creation and modification dates

  this.track.timeScale = this.stream.readUInt32();
  this.track.duration = this.stream.readUInt32() / this.track.timeScale * 1000 | 0;

  this.stream.advance(4); // language and quality
});

// corrections to bits per channel, base on formatID
// (ffmpeg appears to always encode the bitsPerChannel as 16)
const BITS_PER_CHANNEL = {
  ulaw: 8,
  alaw: 8,
  in24: 24,
  in32: 32,
  fl32: 32,
  fl64: 64
};

const LPCM_FORMATS = {
  twos: true,
  sowt: true,
  in24: true,
  in32: true,
  fl32: true,
  fl64: true,
  'raw ': true,
  NONE: true
};

atom('moov.trak.mdia.minf.stbl.stsd', function() {
  this.stream.advance(4); // version and flags

  let numEntries = this.stream.readUInt32();

  // just ignore the rest of the atom if this isn't an audio track
  if (this.track.type !== Track.AUDIO) {
    return this.stream.advance(this.len - 8);
  }

  if (numEntries !== 1) {
    throw new Error("Only expecting one entry in sample description atom!");
  }

  this.stream.advance(4); // size

  let format = this.track.format;
  format.formatID = this.stream.readString(4);

  this.stream.advance(6); // reserved
  this.stream.advance(2); // data reference index

  let version = this.stream.readUInt16();
  this.stream.advance(6); // skip revision level and vendor

  format.channelsPerFrame = this.stream.readUInt16();
  format.bitsPerChannel = this.stream.readUInt16();

  this.stream.advance(4); // skip compression id and packet size

  format.sampleRate = this.stream.readUInt16();
  this.stream.advance(2);

  if (version === 1) {
    format.framesPerPacket = this.stream.readUInt32();
    this.stream.advance(4); // bytes per packet
    format.bytesPerFrame = this.stream.readUInt32();
    this.stream.advance(4); // bytes per sample

  } else if (version !== 0) {
    throw new Error('Unknown version in stsd atom');
  }

  if (BITS_PER_CHANNEL[format.formatID] != null) {
    format.bitsPerChannel = BITS_PER_CHANNEL[format.formatID];
  }

  format.floatingPoint = format.formatID === 'fl32' || format.formatID === 'fl64';
  format.littleEndian = format.formatID === 'sowt' && format.bitsPerChannel > 8;

  if (LPCM_FORMATS[format.formatID]) {
    format.formatID = 'lpcm';
  }
});

atom('moov.trak.mdia.minf.stbl.stsd.alac', function() {
  this.stream.advance(4);
  this.track.format.cookie = this.stream.readBuffer(this.len - 4);
});

// reads a variable length integer
function readDescrLen(stream) {
  let len = 0;
  let count = 4;

  while (count--) {
    let c = stream.readUInt8();
    len = (len << 7) | (c & 0x7f);
    if (!c & 0x80) { break; }
  }

  return len;
}

atom('moov.trak.mdia.minf.stbl.stsd.esds', function() {
  let end = this.stream.offset + this.len;
  
  this.stream.advance(4); // version and flags

  let tag = this.stream.readUInt8();
  let len = readDescrLen(this.stream);

  if (tag === 0x03) { // MP4ESDescrTag
    this.stream.advance(2); // id
    let flags = this.stream.readUInt8();

    if (flags & 0x80) { // streamDependenceFlag
      this.stream.advance(2);
    }

    if (flags & 0x40) { // URL_Flag
      this.stream.advance(this.stream.readUInt8());
    }

    if (flags & 0x20) { // OCRstreamFlag
      this.stream.advance(2);
    }
  } else {
    this.stream.advance(2); // id
  }

  tag = this.stream.readUInt8();
  len = readDescrLen(this.stream);

  if (tag === 0x04) { // MP4DecConfigDescrTag
    let codec_id = this.stream.readUInt8(); // might want this... (isom.c:35)
    this.stream.advance(1); // stream type
    this.stream.advance(3); // buffer size
    this.stream.advance(4); // max bitrate
    this.stream.advance(4); // avg bitrate

    tag = this.stream.readUInt8();
    len = readDescrLen(this.stream);

    if (tag === 0x05) { // MP4DecSpecificDescrTag
      this.track.format.cookie = this.stream.readBuffer(len);
    }
  }
  
  this.stream.seek(end); // skip garbage at the end
});

atom('moov.trak.mdia.minf.stbl.stsd.wave.enda', function() {
  this.track.format.littleEndian = !!this.stream.readUInt16();
});

// time to sample
atom('moov.trak.mdia.minf.stbl.stts', function() {
  this.stream.advance(4); // version and flags

  let entries = this.stream.readUInt32();
  this.track.stts = [];
  for (let i = 0; i < entries; i++) {
    this.track.stts[i] = {
      count: this.stream.readUInt32(),
      duration: this.stream.readUInt32()
    };
  }
});

// sample to chunk
atom('moov.trak.mdia.minf.stbl.stsc', function() {
  this.stream.advance(4); // version and flags

  let entries = this.stream.readUInt32();
  this.track.stsc = [];
  for (let i = 0; i < entries; i++) {
    this.track.stsc[i] = {
      first: this.stream.readUInt32(),
      count: this.stream.readUInt32(),
      id: this.stream.readUInt32()
    };
  }
});

// sample size
atom('moov.trak.mdia.minf.stbl.stsz', function() {
  this.stream.advance(4); // version and flags

  this.track.sampleSize = this.stream.readUInt32();
  let entries = this.stream.readUInt32();

  if (this.track.sampleSize === 0 && entries > 0) {
    this.track.sampleSizes = [];
    for (let i = 0; i < entries; i++) {
      this.track.sampleSizes[i] = this.stream.readUInt32();
    }
  }
});

// chunk offsets
atom('moov.trak.mdia.minf.stbl.stco', function() { // TODO: co64
  this.stream.advance(4); // version and flags

  let entries = this.stream.readUInt32();
  this.track.chunkOffsets = [];
  for (let i = 0; i < entries; i++) {
    this.track.chunkOffsets[i] = this.stream.readUInt32();
  }
});

// chapter track reference
atom('moov.trak.tref.chap', function() {
  let entries = this.len >> 2;
  this.track.chapterTracks = [];
  for (let i = 0; i < entries; i++) {
    this.track.chapterTracks[i] = this.stream.readUInt32();
  }
});

after('moov.trak', function() {
  // setup seek points
  let stscIndex = 0;
  let sttsIndex = 0;
  let sttsSample = 0;
  let sampleIndex = 0;
  let offset = 0;
  let timestamp = 0;

  for (let i = 0; i < this.track.chunkOffsets.length; i++) {
    offset = this.track.chunkOffsets[i];
    while (stscIndex + 1 < this.track.stsc.length && i + 1 === this.track.stsc[stscIndex + 1].first) {
      stscIndex++;
    }

    for (let j = 0, len = this.track.stsc[stscIndex].count; j < len; j++) {
      let length = this.track.sampleSize || this.track.sampleSizes[sampleIndex++];
      let duration = this.track.stts[sttsIndex].duration;
      this.track.seekPoints.push({
        offset,
        length,
        timestamp,
        duration
      });

      offset += length;
      timestamp += duration;

      if (sttsIndex + 1 < this.track.stts.length && ++sttsSample === this.track.stts[sttsIndex].count) {
        sttsSample = 0;
        sttsIndex++;
      }
    }
  }

  this.addTrack(this.track);
  this.track = null;
});

after('moov', function() {
  // create a sorted list of data chunks, linking back to their associated tracks
  this.chunks = [];
  for (let track of this.tracks) {
    for (let seekPoint of track.seekPoints) {
      this.chunks.push({
        track: track,
        offset: seekPoint.offset,
        length: seekPoint.length
      });
    }
  }

  this.chunks.sort((a, b) => a.offset - b.offset);

  // if the mdat block was at the beginning rather than the end, jump back to it
  if (this.mdatOffset != null) {
    this.stream.seek(this.mdatOffset - 8);
  }
});

atom('mdat', function() {
  if (!this.startedData) {
    if (!this.mdatOffset) {
      this.mdatOffset = this.stream.offset;
    }

    // if we haven't read the headers yet, the mdat atom was at the beginning
    // rather than the end. Skip over it for now to read the headers first, and
    // come back later.
    if (this.tracks.length === 0) {
      let bytes = Math.min(this.stream.remainingBytes(), this.len);
      this.stream.advance(bytes);
      this.len -= bytes;
      return;
    }

    this.chunkIndex = 0;
    this.chunkOffset = 0;
    this.startedData = true;
  }

  // read the chapter information if any
  if (!this.readChapters) {
    // this.readChapters = this.parseChapters();
    // if (!this.readChapters) { return; }
    // this.stream.seek(this.mdatOffset);
  }

  // get the next chunk
  let chunk = this.chunks[this.chunkIndex];
  let offset = chunk.offset + this.chunkOffset;
  let length = chunk.length - this.chunkOffset;

  // seek to the offset
  this.stream.seek(offset);

  // read as much as we can, and write to the track
  let buffer = this.stream.readSingleBuffer(length);
  chunk.track.write(buffer);

  // if we read the whole chunk, advance to the next.
  // otherwise, advance the offset in the current chunk.
  if (buffer.length === length) {
    this.chunkIndex++;
    this.chunkOffset = 0;
  } else {
    this.chunkOffset += buffer.length;
  }
});

// metadata chunk
function readMeta() {
  this.metadata = {};
  this.stream.advance(4); // version and flags
}

atom('moov.udta.meta', readMeta);
atom('moov.trak.udta.meta', readMeta);

// emit when we're done
function afterMeta() {
  this.emit('metadata', this.metadata);
}

after('moov.udta.meta', afterMeta);
after('moov.trak.udta.meta', afterMeta);

// convienience function to generate metadata atom handler
function meta(field, name, fn) {
  function readField() {
    this.stream.advance(8);
    this.len -= 8;
    this.metadata[name] = fn.call(this);
  }
  
  atom(`moov.udta.meta.ilst.${field}.data`, readField);
  atom(`moov.trak.udta.meta.ilst.${field}.data`, readField);
}

// string field reader
function string() {
  return this.stream.readString(this.len, 'utf8');
}

// from http://atomicparsley.sourceforge.net/mpeg-4files.html
meta('©alb', 'album', string);
meta('©arg', 'arranger', string);
meta('©art', 'artist', string);
meta('©ART', 'artist', string);
meta('aART', 'albumArtist', string);
meta('catg', 'category', string);
meta('©com', 'composer', string);
meta('©cpy', 'copyright', string);
meta('cprt', 'copyright', string);
meta('©cmt', 'comments', string);
meta('©day', 'releaseDate', string);
meta('desc', 'description', string);
meta('©gen', 'genre', string); // custom genres
meta('©grp', 'grouping', string);
meta('©isr', 'ISRC', string);
meta('keyw', 'keywords', string);
meta('©lab', 'recordLabel', string);
meta('ldes', 'longDescription', string);
meta('©lyr', 'lyrics', string);
meta('©nam', 'title', string);
meta('©phg', 'recordingCopyright', string);
meta('©prd', 'producer', string);
meta('©prf', 'performers', string);
meta('purd', 'purchaseDate', string);
meta('purl', 'podcastURL', string);
meta('©swf', 'songwriter', string);
meta('©too', 'encoder', string);
meta('©wrt', 'composer', string);

meta('covr', 'coverArt', function() {
  return this.stream.readBuffer(this.len);
});

// standard genres
const GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge",
  "Hip-Hop", "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B",
  "Rap", "Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska",
  "Death Metal", "Pranks", "Soundtrack", "Euro-Techno", "Ambient",
  "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical",
  "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
  "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop",
  "Instrumental Rock", "Ethnic", "Gothic",  "Darkwave", "Techno-Industrial",
  "Electronic", "Pop-Folk", "Eurodance", "Dream", "Southern Rock", "Comedy",
  "Cult", "Gangsta", "Top 40", "Christian Rap", "Pop/Funk", "Jungle",
  "Native American", "Cabaret", "New Wave", "Psychadelic", "Rave", "Showtunes",
  "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro",
  "Musical", "Rock & Roll", "Hard Rock", "Folk", "Folk/Rock", "National Folk",
  "Swing", "Fast Fusion", "Bebob", "Latin", "Revival", "Celtic", "Bluegrass",
  "Avantgarde", "Gothic Rock", "Progressive Rock", "Psychedelic Rock", "Symphonic Rock",
  "Slow Rock", "Big Band", "Chorus", "Easy Listening", "Acoustic", "Humour", "Speech",
  "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony", "Booty Bass", "Primus",
  "Porn Groove", "Satire", "Slow Jam", "Club", "Tango", "Samba", "Folklore", "Ballad",
  "Power Ballad", "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock", "Drum Solo",
  "A Capella", "Euro-House", "Dance Hall"
];

meta('gnre', 'genre', function() {
  return GENRES[this.stream.readUInt16() - 1];
});

meta('tmpo', 'tempo', function() {
  return this.stream.readUInt16();
});

meta('rtng', 'rating', function() {
  let rating = this.stream.readUInt8();
  return rating === 2 ? 'Clean' : rating !== 0 ? 'Explicit' : 'None';
});

function diskTrack() {
  this.stream.advance(2);
  let res = this.stream.readUInt16() + ' of ' + this.stream.readUInt16();
  this.stream.advance(this.len - 6);
  return res;
}

meta('disk', 'diskNumber', diskTrack);
meta('trkn', 'trackNumber', diskTrack);

function bool(field) {
  return this.stream.readUInt8() === 1;
}

meta('cpil', 'compilation', bool);
meta('pcst', 'podcast', bool);
meta('pgap', 'gapless', bool);
