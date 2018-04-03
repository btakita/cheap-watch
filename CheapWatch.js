import EventEmitter from 'events';
import { readdir, stat, watch } from 'fs';
import { promisify } from 'util';

const readdirAsync = promisify(readdir);
const statAsync = promisify(stat);

const _watchers = Symbol('_watchers');
const _timeouts = Symbol('_timeouts');
const _queue = Symbol('_queue');
const _isProcessing = Symbol('_isProcessing');
const _isInited = Symbol('_isInited');
const _isClosed = Symbol('_isClosed');
const _recurse = Symbol('_recurse');
const _handle = Symbol('_handle');
const _enqueue = Symbol('_enqueue');

export default class CheapWatch extends EventEmitter {
	constructor({ dir, filter, watch = true, debounce = 10 }) {
		super();
		// root directory
		this.dir = dir;
		// (optonal) function to limit watching to certain directories/files
		this.filter = filter;
		// (optional) whether to actually watch for changes, or just report all matching files and their stats
		this.watch = watch;
		// (optional) number of milliseconds to use to debounce events from FSWatcher
		this.debounce = debounce;
		// paths of all directories -> FSWatcher instances
		this[_watchers] = new Map();
		// paths of all files/dirs -> stats
		this.files = new Map();
		// paths of files with pending debounced events -> setTimeout timer ids
		this[_timeouts] = new Map();
		// queue of pending FSWatcher events to handle
		this[_queue] = [];
		// whether some FSWatcher event is currently already in the process of being handled
		this[_isProcessing] = false;
		// whether init has been called
		this[_isInited] = false;
		// whether close has been called
		this[_isClosed] = false;
	}

	// recurse directroy, get stats, set up FSWatcher instances
	// returns array of { path, stats }
	async init() {
		if (this[_isInited]) {
			throw new Error('Cannot init a CheapWatch that has already been inited');
		}
		this[_isInited] = true;
		await this[_recurse](this.dir);
	}

	// close all FSWatchers
	close() {
		if (!this[_isInited]) {
			throw new Error('Cannot close a CheapWatch that has not yet been inited');
		}
		if (this[_isClosed]) {
			throw new Error('Cannot close a CheapWatch that has already been closed');
		}
		this[_isClosed] = true;
		for (const watcher of this[_watchers].values()) {
			watcher.close();
		}
	}

	// recurse a given directory
	async [_recurse](full) {
		const path = full.slice(this.dir.length + 1);
		const stats = await statAsync(full);
		if (this.filter && !await this.filter({ path, stats })) {
			return;
		}
		this.files.set(path, stats);
		if (stats.isDirectory()) {
			if (this.watch) {
				this[_watchers].set(
					path,
					watch(full, this[_handle].bind(this, full)).on('error', () => {}),
				);
			}
			await Promise.all(
				(await readdirAsync(full)).map(sub => this[_recurse](full + '/' + sub)),
			);
		}
	}

	// handle FSWatcher event for given directory
	[_handle](dir, event, file) {
		const full = dir + '/' + file;
		if (this[_timeouts].has(full)) {
			clearTimeout(this[_timeouts].get(full));
		}
		this[_timeouts].set(
			full,
			setTimeout(() => {
				this[_timeouts].delete(full);
				this[_enqueue](full);
			}, this.debounce),
		);
	}

	// add an FSWatcher event to the queue, and handle queued events
	async [_enqueue](full) {
		this[_queue].push(full);
		if (this[_isProcessing]) {
			return;
		}
		this[_isProcessing] = true;
		while (this[_queue].length) {
			const full = this[_queue].shift();
			const path = full.slice(this.dir.length + 1);
			try {
				const stats = await statAsync(full);
				if (this.filter && !await this.filter({ path, stats })) {
					continue;
				}
				this.files.set(path, stats);
				this.emit('+', { path, stats });
				if (stats.isDirectory() && !this[_watchers].has(path)) {
					// note the new directory
					// start watching it, and report any files in it
					await this[_recurse](full);
					for (const [newPath, stats] of this.files.entries()) {
						if (newPath.startsWith(path + '/')) {
							this.emit('+', { path: newPath, stats });
						}
					}
				}
			} catch (e) {
				// check whether this is a deleted file/dir or just some FSWatcher artifact
				if (this.files.has(path)) {
					// note the deleted file/dir
					const stats = this.files.get(path);
					this.files.delete(path);
					this.emit('-', { path, stats });
					if (this[_watchers].has(path)) {
						// stop watching it, and report any files/dirs that were in it
						for (const old of this[_watchers].keys()) {
							if (old === path || old.startsWith(path + '/')) {
								this[_watchers].get(old).close();
								this[_watchers].delete(old);
							}
						}
						for (const old of this.files.keys()) {
							if (old.startsWith(path + '/')) {
								const stats = this.files.get(old);
								this.files.delete(old);
								this.emit('-', { path: old, stats });
							}
						}
					}
				}
			}
		}
		this[_isProcessing] = false;
	}
}
