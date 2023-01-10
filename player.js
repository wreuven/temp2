import { SegmentHandler } from './mediaSegmentHandler.js';
import { DrmController } from './drmController.js';
import { fetchRetry } from './utils.js';

class HyperscalePlayer extends EventTarget {
	/**
	  * @param {HTMLVideoElement} videoElement
	  */
	constructor(videoElement) {
		super()
		this.cloudPlayerApi = null
		this.maxBufferDuration = 20
		this.segmentWatchDogSec = 30
		this.minBandwidth = 0
		this.maxBandwidth = 50000

		this.videoElement = videoElement

		this.bufferFeedIntervalMs = 500
		this.bufferJumpsDetectionInterval = 100

		// PlaylistUpdaterTask settings
		this.minDesiredFutureSegments = 2
		this.minPlaylistRefreshBufferPercentageThreshold = 75

		this.sourceAudioBuffer = null
		this.sourceVideoBuffer = null
	}

	_raiseEosEvent(data) {
		data.playbackInfo = this.GetPlaybackInfo()
		this.dispatchEvent(new CustomEvent('streamend', { detail: data }));
	}
	_raiseErrorEvent(data) {
		data.playbackInfo = this.GetPlaybackInfo()
		this.dispatchEvent(new CustomEvent('error', { detail: data }))
	}

	/**
	 * @param {string} [manifestUrl]
	 */
	Setup(options) {
		this.deviceId = options.deviceId || "";
		this.connectionId = options.connectionId || "";

		this.cloudPlayerApi = options.cloudPlayer + "/cloud-player/1.0/playlist";
		this.manifestUrl = options.manifestUrl;
		this.initialBandwidth = options.initialBandwidth
		this.initialPosition = options.initialPosition
		this.congestionControlEnabled = options.congestionControlEnabled
		this.useCanary = options.useCanary

		this.bufferBusy = false
		this.nextBufferStatsLogTime = null

		this.lastVideoSegmentTime = null
		this.lastAudioSegmentTime = null

		this.mediaSource = new MediaSource();

		this.videoElement.onerror = (event) => {
			console.warn(`Error loading media to video element: ${event.target.error.message}`);
			this._raiseErrorEvent({
				errorText: 'ABR_VIDEO_ELEMENT_ERROR',
				errorCode: 30,
				message: `ABR Player error: ${event.target.error.message}`
			});
			this.Stop()
		};

		this.videoElement.onended = () => {
			console.warn("Video playback reached the end")
			this._raiseEosEvent({});
			this.Stop()
		};

		this.videoElement.onstalled = () => {
			console.warn(`Video onstalled called, currentTime = ${this.videoElement.currentTime}`)
		};

		this.videoElement.addEventListener(`waitingforkey`, (event) => {
			console.warn(`Event: waitingforkey`, event)
		})
		this.videoElement.addEventListener(`encrypted`, (mediaEncryptedEvent) => {
			console.warn(`Event: encrypted`, mediaEncryptedEvent)
		})

		this.videoElement.src = URL.createObjectURL(this.mediaSource);

		this.videoSegmentHandler = new SegmentHandler({
			mediaType: "VIDEO",
			initialBandwidth: this.initialBandwidth,
			congestionControlEnabled: this.congestionControlEnabled
		})

		this.audioSegmentHandler = new SegmentHandler({
			mediaType: "AUDIO",
			initialBandwidth: this.initialBandwidth,
			congestionControlEnabled: this.congestionControlEnabled
		})

		this.drmController = new DrmController()
		this.drmController.addEventListener('newpssh', (event) => {
			console.info(`Got PSSH: ${event.detail.pssh}`)
			this.dispatchEvent(new CustomEvent('newpssh', { detail: event.detail }))
		})
	}

	async StartBuffering() {
		this.lastVideoSegmentTime = Date.now()
		this.lastAudioSegmentTime = Date.now()

		let playlistParams = {
			maxDuration: this.maxBufferDuration,
			minBandwidth: this.minBandwidth,
			maxBandwidth: this.maxBandwidth,
			initialPosition: this.initialPosition,
		}
		try {
			let playback = await this.getPlaylists(playlistParams, 5)
			this.assetDuration = playback.duration
			this.assetType = playback.isLive ? "LIVE" : "VOD"
			this.drmController.RefreshPlaylists(playback)

			this.timeShiftBufferDepth = playback.timeShiftBufferDepth;
			this.suggestedPresentationDelay = playback.suggestedPresentationDelay;

			await this.videoSegmentHandler.refreshPlaylists(playback.playlists.video)
			await this.audioSegmentHandler.refreshPlaylists(playback.playlists.audio)
		} catch (err) {
			console.warn(`Failed to initialize playlist: ${err.message}`);
			this._raiseErrorEvent({
				errorText: 'PLAYLIST_INITIALIZATION_FAILED',
				errorCode: 31,
				message: err.message
			})
			this.Stop()
		}


		this.sourceVideoBuffer = await this._addSourceBufferWhenOpen(this.mediaSource, `video/mp4; codecs="avc1.64001F"`, 'segments');
		//this.sourceVideoBuffer = await addSourceBufferWhenOpen(this.mediaSource, `video / mp4; codecs = "avc3.4D401F""`, 'segments');
		this.sourceAudioBuffer = await this._addSourceBufferWhenOpen(this.mediaSource, `audio/mp4; codecs="mp4a.40.2"`, 'segments');

		/* this.sourceVideoBuffer.onupdateend = async () => {
			if (!this.videoSegmentHandler.hasNextSegment()) {
				console.warn(`no more video segments, should update manifest`);
			}
		};
		
		this.sourceAudioBuffer.onupdateend = async () => {
			if (!this.audioSegmentHandler.hasNextSegment()) {
				console.warn(`no more audio segments, should update manifest`);
			}
		}; */

		// first segment we play. Seek to correct position since live streams are not starting with time 0
		let videoStartTime = this.videoSegmentHandler.getNextSegmentStartTime()
		let audioStartTime = this.audioSegmentHandler.getNextSegmentStartTime()
		/* position of the player should be set to the greater start time, otherwise the it will hang forever waiting 
		   for both video and audio frames to match that time */
		this.videoElement.currentTime = Math.max(videoStartTime, audioStartTime)
		console.info(`set initial player position to ${this.videoElement.currentTime}`)

		this.bufferFeedTimer = setInterval(async () => {
			if (this.bufferBusy) {
				return
			}
			this.bufferBusy = true
			try {
				await this._buffersFeedTask()
			}
			catch (err) {
				console.warn(err, err.stack);
			}
			finally {
				this.bufferBusy = false
			}
		}, this.bufferFeedIntervalMs);

		this.bufferJumpDetectionTimer = setInterval(async () => {
			this._videoJumpDetectionSeekTask()
		}, this.bufferJumpsDetectionInterval);

	}

	Play() {
		this.videoElement.play()
	}

	Stop() {
		clearInterval(this.bufferFeedTimer)
		clearInterval(this.bufferJumpDetectionTimer)

		if (this.mediaSource != null && this.mediaSource.readyState == 'open') {
			this.mediaSource.endOfStream()
		}
		this.videoElement.pause()
		this.videoElement.currentTime = 0
		this.videoElement.removeAttribute('src');
		this.nextBufferStatsLogTime = null
		this.sourceVideoBuffer = null
		this.sourceAudioBuffer = null

	}

	GetPlaybackInfo() {
		let info = {
			playbackUrl: this.manifestUrl,
			assetType: this.assetType,
			currentPosition: this.videoElement.currentTime,
		}
		if (this.assetType == "VOD") {
			info.assetDuration = this.assetDuration
			info.assetStart = 0
			info.assetEnd = this.assetDuration
		} else {
			info.assetDuration = -1
			info.assetStart = this.timeShiftBufferDepth ? Date.now() / 1000 - this.timeShiftBufferDepth : -1;
			info.assetEnd = this.suggestedPresentationDelay ? Date.now() / 1000 - this.suggestedPresentationDelay : Date.now() / 1000;
		}
		return info
	}

	GetCurrentVideoAttributes() {
		if (this.videoSegmentHandler) {
			return this.videoSegmentHandler.getCurrentPlaylistAttributes()
		}
		return null
	}
	/**
	 * @param {{ map: any; resolvedUri?: any; duration?: any; }} params
	 */
	async getPlaylists(params, maxRetries) {
		console.log("requesting playlist from cloud");

		var urlParams = { "url": this.manifestUrl, ...params };
		var url = new URL(this.cloudPlayerApi);
		for (let k in urlParams) { url.searchParams.append(k, urlParams[k]); }
		let headers = {
			"x-device-id": this.deviceId,
			"x-connection-id": this.connectionId
		}
		if (this.useCanary) {
			headers['x-hyperscale-canary'] = 'always'
		}

		try {
			let respJson = await fetchRetry(url, { headers: headers }, maxRetries, 2000);
			return respJson
		} catch (err) {
			throw new Error(`Error while fetching manifest url ${url}: ${err}`)
		}

	}

	async refreshPlaylist() {
		// Don't refresh the playlist if we have more than 75% available buffer
		let remainingBuffers = this.getRemainingAudioVideoBuffers()
		let futureVideoBufferPercentage = remainingBuffers.video / this.maxBufferDuration * 100
		let futureAudioBufferPercentage = remainingBuffers.audio / this.maxBufferDuration * 100
		let minBufferPercentage = Math.min(futureVideoBufferPercentage, futureVideoBufferPercentage)
		if (minBufferPercentage >= this.minPlaylistRefreshBufferPercentageThreshold) {
			console.debug(`Skipping playlist refresh since min buffer is ${minBufferPercentage}`)
			return
		}
		// Check if we have desired number of remaining segments , if not, refresh the playlist
		if (this.videoSegmentHandler.getRemainingSegmentsCount() >= this.minDesiredFutureSegments &&
			this.audioSegmentHandler.getRemainingSegmentsCount() >= this.minDesiredFutureSegments) {
			return
		}
		let lastVideoSegment = this.videoSegmentHandler.getLastSegment()
		let lastAudioSegment = this.audioSegmentHandler.getLastSegment()

		/* Never attempt to update a playlist if we've not been able yet to get at least one segment of audio and video
		We may be stuck due to 404, and we'll keep trying to get the missing segment, no point with refreshing since we should never skip segments) */
		if (lastAudioSegment == null || lastAudioSegment == null) {
			console.debug("Skipping playlist refresh until first audio and video segments will be retrieved")
			return
		}
		let params = {
			maxDuration: this.maxBufferDuration,
			minBandwidth: this.minBandwidth,
			maxBandwidth: this.maxBandwidth,
			lastVideoPresentationTime: lastVideoSegment.presentationTime,
			lastAudioPresentationTime: lastAudioSegment.presentationTime,
			lastVideoTimeline: lastVideoSegment.timeline,
			lastAudioTimeline: lastAudioSegment.timeline
		}
		try {
			let playback = await this.getPlaylists(params, 1)

			this.timeShiftBufferDepth = playback.timeShiftBufferDepth;
			this.suggestedPresentationDelay = playback.suggestedPresentationDelay;

			this.videoSegmentHandler.refreshPlaylists(playback.playlists.video)
			this.audioSegmentHandler.refreshPlaylists(playback.playlists.audio)
		} catch (err) {
			console.warn(err, err.stack)
		}
	}

	async _buffersFeedTask() {
		let remainingBuffers = this.getRemainingAudioVideoBuffers()
		let futureVideoBuffer = remainingBuffers.video
		let futureAudioBuffer = remainingBuffers.audio

		// Log buffer stats
		if (Date.now() > this.nextBufferStatsLogTime) {
			this.nextBufferStatsLogTime = Date.now() + 5000
			console.debug(`currentTime:${this.videoElement.currentTime}, futureVideoBuffer:${futureVideoBuffer},  futureAudioBuffer:${futureAudioBuffer}`);
		}

		// Check for end of playlists
		if (this.assetDuration > 0 && (this.videoSegmentHandler.hasNoSegments() || this.audioSegmentHandler.hasNoSegments())) {
			if (this.mediaSource.readyState == 'open') {
				console.info("Detected end of audio or video playlists, setting EOS of mediaSource")
				this.mediaSource.endOfStream();
			}
			return
		}

		// WatchDog since last time video and audio segments retrieved
		let timeSinceLastVideoSegmentSec = (Date.now() - this.lastVideoSegmentTime) / 1000
		let timeSinceLastAudioSegmentSec = (Date.now() - this.lastAudioSegmentTime) / 1000
		if (timeSinceLastVideoSegmentSec > this.segmentWatchDogSec || timeSinceLastAudioSegmentSec > this.segmentWatchDogSec) {
			console.warn(`Stopping playback. Segment watchdog fired. timeSinceLastVideoSegmentSec=${timeSinceLastVideoSegmentSec}, timeSinceLastAudioSegmentSec=${timeSinceLastAudioSegmentSec}`)
			this.Stop()
			this._raiseErrorEvent({
				errorText: 'ABR_PLAYER_NO_DATA_TIMEOUT',
				errorCode: 32,
				message: "ABR Timeout waiting for segments to be fetched"
			});
			return
		}

		// Refresh playlist if needed before fetching next segments
		await this.refreshPlaylist()

		try {
			// Fetch next video segment if needed
			if (futureVideoBuffer < this.maxBufferDuration) {
				let videoSegment = await this.videoSegmentHandler.getNextSegment()
				if (videoSegment.buffer != null) {
					if (videoSegment.includesInitSegment) {
						//this.sourceVideoBuffer.changeType(`video / mp4; codecs = "${videoSegment.codecs}"`)
						/*  Chrome seems to support HEVS since version 107 (October 2022) but doesn't seem to support "hvc1" codec, 
							at least for Costa-Rica clip it seems to play it find by changing the codec to "hvc1.1.6.L63.90" */
						let videoCodecs = videoSegment.codecs
						if (videoCodecs == "hvc1") {
							videoCodecs = "hvc1.1.6.L63.90"
						}

						this.sourceVideoBuffer.changeType(`video/mp4; codecs="${videoCodecs}"`)
					}
					console.debug(`Appending VIDEO segment to buffer. Timeline=${videoSegment.timeline} PT=${videoSegment.presentationTime}-${videoSegment.presentationTime + videoSegment.duration} Duration=${videoSegment.duration}, hasInitSeg=${videoSegment.includesInitSegment}`)
					let lastSegment = this.videoSegmentHandler.getLastSegment()
					if (lastSegment) {
						let segmentJump = videoSegment.presentationTime - (lastSegment.presentationTime + lastSegment.duration)
						if (segmentJump > 0.2) {
							console.warn(`Detected VIDEO segment PT jump of ${segmentJump}s. Timeline=${videoSegment.timeline} PT=${videoSegment.presentationTime}-${videoSegment.presentationTime + videoSegment.duration} Duration=${videoSegment.duration}, hasInitSeg=${videoSegment.includesInitSegment}`)
						}
					}
					this.sourceVideoBuffer.timestampOffset = videoSegment.timeline
					this.sourceVideoBuffer.appendBuffer(videoSegment.buffer);
					this.lastVideoSegmentTime = Date.now()
					this.videoSegmentHandler.advanceSegment()
				}
			}
		} catch (err) {
			console.warn(err, err.stack);
		}

		try {
			// Fetch next audio segment if needed
			if (futureAudioBuffer < this.maxBufferDuration) {
				let audioSegment = await this.audioSegmentHandler.getNextSegment()
				if (audioSegment.buffer != null) {
					if (audioSegment.includesInitSegment) {
						this.sourceAudioBuffer.changeType(`audio/mp4; codecs="${audioSegment.codecs}"`)
					}
					console.debug(`Appending AUDIO segment to buffer. Timeline=${audioSegment.timeline} PT=${audioSegment.presentationTime}-${audioSegment.presentationTime + audioSegment.duration} Duration=${audioSegment.duration}, hasInitSeg=${audioSegment.includesInitSegment}`)
					let lastSegment = this.audioSegmentHandler.getLastSegment()
					if (lastSegment) {
						let segmentJump = audioSegment.presentationTime - (lastSegment.presentationTime + lastSegment.duration)
						if (segmentJump > 0.2) {
							console.warn(`Detected AUDIO segment PT jump of ${segmentJump}s. Timeline=${audioSegment.timeline} PT=${audioSegment.presentationTime}-${audioSegment.presentationTime + audioSegment.duration} Duration=${audioSegment.duration}, hasInitSeg=${audioSegment.includesInitSegment}`)
						}
					}
					this.sourceAudioBuffer.timestampOffset = audioSegment.timeline
					this.sourceAudioBuffer.appendBuffer(audioSegment.buffer);
					this.lastAudioSegmentTime = Date.now()
					this.audioSegmentHandler.advanceSegment()
				}
			}
		} catch (err) {
			console.warn(err, err.stack);
		}
	}

	async _videoJumpDetectionSeekTask() {
		/* Ensures player is seeked to correct position which has buffered content
		If the current video element position is out of the buffered ranges, seek to the start of the closest buffered range
		TODO in the future, seek when gaps are found between segments as similary being done by dash.hs
		https://github.com/Dash-Industry-Forum/dash.js/blob/3c91333e4e8b7985e2ef47606d942f4d1c32b389/src/streaming/controllers/GapController.js#L308  */

		let bufferedRanges = this.videoElement.buffered
		if (bufferedRanges.length == 0) {
			return
		}
		// Check if current player position is within buffer ranges
		let currentPlayerPosition = this.videoElement.currentTime
		for (let i = 0; i < bufferedRanges.length; i++) {
			if (this._isTimeBuffered(bufferedRanges, currentPlayerPosition)) {
				return
			}
		}

		// Current player position is out of buffer range, seek it to the start of the adjucent buffer range
		let nextRangeStart = this._getAdjacentBufferRangeStartTime(bufferedRanges, currentPlayerPosition)
		if (nextRangeStart !== null) {
			console.warn(`Current player position ${currentPlayerPosition}s is out of buffer ranges, seeking to start of next buffer ${nextRangeStart}s`)
			this.videoElement.currentTime = nextRangeStart
		}
	}
	_getAdjacentBufferRangeStartTime(ranges, currentTime) {
		for (let i = 0; i < ranges.length; i++) {
			let start = ranges.start(i)
			let end = ranges.end(i)
			if (currentTime < start && currentTime <= end) {
				return start
			}
		}
		return null
	}

	_isTimeBuffered(ranges, currentTime) {
		for (let i = 0, len = ranges.length; i < len; i++) {
			if (currentTime >= ranges.start(i) && currentTime <= ranges.end(i)) {
				return true;
			}
		}
		return false;
	}

	getRemainingAudioVideoBuffers() {
		if (this.sourceVideoBuffer == null || this.sourceAudioBuffer == null) {
			return { audio: 0, video: 0 }
		}
		let videoBufferRanges = this.sourceVideoBuffer.buffered
		let audioBufferRanges = this.sourceAudioBuffer.buffered
		let futureVideoBuffer = 0
		let futureAudioBuffer = 0
		if (videoBufferRanges.length > 0) {
			futureVideoBuffer = videoBufferRanges.end(videoBufferRanges.length - 1) - this.videoElement.currentTime
		}
		if (audioBufferRanges.length > 0) {
			futureAudioBuffer = audioBufferRanges.end(audioBufferRanges.length - 1) - this.videoElement.currentTime
		}
		return {
			audio: futureAudioBuffer,
			video: futureVideoBuffer
		}
	}
	/**
	 * Adds (and returns once ready) a SourceBuffer to a MediaSource
	 * @param {MediaSource} mediaSource
	 * @param {string} mimeStr Example: `video / webm; codecs = "vp9,opus"`
	 * @param {'sequence' | 'segments'} [mode]
	 * @returns {Promise<SourceBuffer>}
	 */
	_addSourceBufferWhenOpen = (mediaSource, mimeStr, mode = 'segments') => {
		return new Promise((res, rej) => {
			let getSourceBuffer = () => {
				try {
					const sourceBuffer = mediaSource.addSourceBuffer(mimeStr);
					sourceBuffer.mode = mode;
					res(sourceBuffer);
				} catch (e) {
					rej(e);
				}
			};
			if (mediaSource.readyState === 'open') {
				getSourceBuffer();
			} else {
				mediaSource.addEventListener('sourceopen', getSourceBuffer);
			}
		});
	}
}

export { HyperscalePlayer };
