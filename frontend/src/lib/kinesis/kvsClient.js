import KinesisSDK from './kinesisSDK';
import config from '$lib/config';
import KVSLogger from '$lib/logging/kvsLogger';
// import { SignalingClient, Role } from 'amazon-kinesis-video-streams-webrtc';
import { SignalingClient } from 'amazon-kinesis-video-streams-webrtc/lib/SignalingClient';
import { Role } from 'amazon-kinesis-video-streams-webrtc/lib/Role';

export default class KVSClient {
	/**
	 * @param {Role} role
	 * @param {String} channelName
	 * @param {String} userName
	 */
	constructor(role, channelName, userName) {
		this.role = role;
		this.channelName = channelName;
		this.clientId = userName;
		this.connectedKVS = false;
		this.reportLogs = config.reportLogs;
		this.saveLogs = config.saveLogs;
		this.printConsole = config.printConsole;
		this.turnOnly = config.turnOnly;
		this.tracks = [];
		this.receivedTraffics = 0;
	}

	async init() {
		const { ChannelARN } = (await KinesisSDK.getSignalingChannel(this.channelName)).ChannelInfo;
		const wssEndpoint = await KinesisSDK.getEndpoints(ChannelARN, 'WSS', this.role);
		const iceServerList = await KinesisSDK.getIceServerList(ChannelARN, this.role);

		this.logger = new KVSLogger(this.reportLogs, this.saveLogs, this.printConsole);
		await this.logger.init();

		this.signalingClient = new SignalingClient({
			role: this.role,
			clientId: this.role == Role.MASTER ? null : this.clientId,
			region: config.kinesisRegion,
			channelARN: ChannelARN,
			channelEndpoint: wssEndpoint,
			credentials: {
				accessKeyId: config.kinesisAccessKeyId,
				secretAccessKey: config.kinesisSecretAccessKey
			}
		});

		this.peerConnection = new RTCPeerConnection({
			iceServers: iceServerList,
			iceTransportPolicy: this.turnOnly ? 'relay' : 'all'
		});

		this.signalingClient.on('open', async () => {
			if (this.KvsConnectionStateHandler) {
				this.connectedKVS = true;
				this.KvsConnectionStateHandler('connected');
			}
			this.logger.post(
				this.channelName,
				this.clientId,
				this.role,
				'KVS',
				`[${this.role}] Connected to signaling service`
			);
		});

		this.signalingClient.on('iceCandidate', async (candidate, remoteClientId) => {
			this.logger.post(
				this.channelName,
				this.clientId,
				this.role,
				'ICE',
				`[${this.role}] Received ICE candidate from client: ${remoteClientId}, ${candidate.candidate}`
			);

			// Add the ICE candidate received from the client to the peer connection
			this.peerConnection.addIceCandidate(candidate);
		});

		this.signalingClient.on('close', () => {
			if (this.KvsConnectionStateHandler) {
				this.connectedKVS = false;
				this.KvsConnectionStateHandler('disconnected');
			}
			this.logger.post(
				this.channelName,
				this.clientId,
				this.role,
				'KVS',
				`[${this.role}] Disconnected from signaling channel`
			);
		});

		this.signalingClient.on('error', (e) => {
			this.logger.post(
				this.channelName,
				this.clientId,
				this.role,
				'Error',
				`[${this.role}] Signaling client error : ${e}`
			);
		});

		this.peerConnection.addEventListener('iceconnectionstatechange', ({ target }) => {
			this.logger.post(
				this.channelName,
				this.clientId,
				this.role,
				'WebRTC',
				`[${this.role}] iceConnectionState changed : ${target.iceConnectionState}`
			);
			if (this.iceConnectionStateHandler) this.iceConnectionStateHandler(target.iceConnectionState);
		});

		this.peerConnection.addEventListener('connectionstatechange', ({ target }) => {
			this.logger.post(
				this.channelName,
				this.clientId,
				this.role,
				'WebRTC',
				`[${this.role}] connectionState changed : ${target.connectionState}`
			);
			if (this.connectionStateHandler) this.connectionStateHandler(target.connectionState);
		});
	}

	connectKVS() {
		this.logger.post(
			this.channelName,
			this.clientId,
			this.role,
			'KVS',
			`[${this.role}] Starting connection`
		);
		this.signalingClient.open();
	}

	disconnectKVS() {
		this.signalingClient.close();
	}

	stopWebRTC() {
		this.peerConnection.close();
		this.peerConnection.dispatchEvent(new Event('iceconnectionstatechange'));
		this.peerConnection.dispatchEvent(new Event('connectionstatechange'));
	}

	getCandidates() {
		return new Promise((resolve, reject) => {
			this.peerConnection.getStats(null).then((stats) => {
				let candidatePairs = [];
				stats.forEach((report) => {
					if (report.type == 'candidate-pair' && report.nominated && report.state == 'succeeded')
						candidatePairs.push(report);
				});

				if (candidatePairs.length === 0) return reject('No succeeded candidate pair exist');

				candidatePairs.sort((a, b) => {
					return b.lastPacketReceivedTimestamp - a.lastPacketReceivedTimestamp;
				});

				const localCandidate = stats.get(candidatePairs[0].localCandidateId);
				const remoteCandidate = stats.get(candidatePairs[0].remoteCandidateId);
				this.logger.post(
					this.channelName,
					this.clientId,
					this.role,
					'WebRTC',
					`[${this.role}] local candidate : ${JSON.stringify(
						localCandidate
					)} /// connected candidate : ${JSON.stringify(remoteCandidate)}`
				);
				return resolve({ localCandidate, remoteCandidate });
			});
		});
	}

	getReceivedTraffics() {
		return new Promise((resolve, reject) => {
			this.peerConnection.getStats(null).then((stats) => {
				let candidatePairs = [];
				stats.forEach((report) => {
					if (report.type == 'candidate-pair' && report.nominated && report.state == 'succeeded')
						candidatePairs.push(report);
				});

				if (candidatePairs.length === 0) return reject('No succeeded candidate pair exist');

				candidatePairs.sort((a, b) => {
					return b.lastPacketReceivedTimestamp - a.lastPacketReceivedTimestamp;
				});

				const result = candidatePairs[0].packetsReceived - this.receivedTraffics;
				this.receivedTraffics = candidatePairs[0].packetsReceived;
				return resolve(result);
			});
		});
	}

	registerKvsConnectionStateHandler(handler) {
		this.KvsConnectionStateHandler = handler;
	}

	registerIceConnectionStateHandler(handler) {
		this.iceConnectionStateHandler = handler;
	}

	registerConnectionStateHandler(handler) {
		this.connectionStateHandler = handler;
	}

	toggleReportLogs(onOff) {
		this.reportLogs = onOff;
		if (this.logger) this.logger.toggleReportLogs(onOff);
	}

	toggleSaveLogs(onOff) {
		this.saveLogs = onOff;
		if (this.logger) this.logger.toggleSaveLogs(onOff);
	}

	togglePrintConsole(onOff) {
		this.printConsole = onOff;
		if (this.logger) this.logger.togglePrintConsole(onOff);
	}

	toggleTURNOnly(onOff) {
		this.turnOnly = onOff;
	}
}
