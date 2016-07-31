# mp4.js

A streaming MP4 demuxer in JavaScript, for [av.js](https://github.com/audiocogs/aurora.js).

## Example

Like all [av.js](https://github.com/audiocogs/aurora.js) demuxers, mp4.js is a writable stream
that you pipe mp4 data to. It emits `'track'` events, each with a readable stream containing
the data for that track.

The following example shows how you might extract just the audio track to a file.

```javascript
import {MP4Demuxer} from 'mp4';
import fs from 'fs';

fs.createReadStream('movie.mp4')
  .pipe(new MP4Demuxer)
  .on('track', function(track) {
    console.log(track.type, track.format)
    
    if (track.type === 'audio') {
      track.pipe(fs.createWriteStream('audio.out'));
    } else {
      track.discard();
    }
  });
```

# License

MIT
