import {Demuxer} from 'av';
import {atoms} from './atoms';

// common file type identifiers
// see http://mp4ra.org/filetype.html for a complete list
const TYPES = ['M4A ', 'M4P ', 'M4B ', 'M4V ', 'isom', 'mp42', 'qt  '];

export default class MP4Demuxer extends Demuxer {
  static probe(buffer) {
    return buffer.peekString(4, 4) === 'ftyp' &&
           TYPES.indexOf(buffer.peekString(8, 4)) !== -1;
  }

  init() {
    // current atom heirarchy stacks
    this.atoms = [];
    this.offsets = [];
  }

  readChunk() {
    let readHeaders = false;
    if (!this.type) {
      this.len = this.stream.readUInt32() - 8;
      this.type = this.stream.readString(4);
      if (this.len === 0) {
        this.type = null;
        return;
      }

      this.atoms.push(this.type);
      this.offsets.push(this.stream.offset + this.len);
      readHeaders = true;
    }

    // find a handler for the current atom heirarchy
    let path = this.atoms.join('.');
    let handler = atoms[path];
    let isContainer = handler && handler.container;

    try {
      // call the parser for this atom, or
      // skip it if it is not a container atom
      if (handler && handler.fn) {
        handler.fn.call(this);
      } else if (!isContainer) {
        this.stream.advance(this.len);
      }
    } catch (e) {
      // If we read the headers in this call and got an
      // underflow, pop the current atom from the stack.
      // We'll read it again when we have more data available.
      if (readHeaders) {
        this.popAtom();
      }
      
      throw e;
    }

    // if this atom is a container, reset the 
    // type so we read the atoms inside it.
    if (isContainer) {
      this.type = null;
    }

    // pop completed items from the stack
    while (this.stream.offset >= this.offsets[this.offsets.length - 1]) {
      // call after handler
      handler = atoms[this.atoms.join('.')];
      if (handler && handler.after) {
        handler.after.call(this);
      }

      this.popAtom();
    }
  }
  
  popAtom() {
    this.atoms.pop();
    this.offsets.pop();
    this.type = null;
  }
}

Demuxer.register(MP4Demuxer);
