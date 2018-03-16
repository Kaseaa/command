const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
    "private_channel_name": "Proxy",
    "login_message": true,
    "public_enable": true,
    "commandPrefixes": ["!", ".", "$"],
    "authorName": "",
    "showCommandsCommands": ["commands", "cmds", "command", "cmd"]
};


let config = require('./config.json');
// Config migration -- backwards compatability
config = Object.assign({}, DEFAULT_CONFIG, config);
// Save new config file -- just to be safe
fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(config, null, "    "));

const DEFAULT_HOOK_SETTINGS_ON_CHAT = {order: 10};
const REPLACE_SYMBOLS_ON_MESSAGE = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;"
};

const PRIVATE_CHANNEL_INDEX = 7;
const PRIVATE_CHANNEL_ID = -2 >>> 0;

class Command {
	constructor(dispatch) {
		let currentHookNum = 0xffffffff;
		let hooks = {};
		let loaded = false;

		/** Functions for this class **/
		this.add = (cmd, callback, id) => {
			if(Array.isArray(cmd)) {
				for(let i in cmd) this.add(cmd[i], callback, id);
				return;
			}

			if(!cmd || !callback) return console.error(`Failed to add command ${cmd}.`);
			// Case insensitivity \o/
			cmd = cmd.toLowerCase();
			if(!hooks[cmd]) hooks[cmd] = [];

			hooks[cmd].push({
				"id": id || --currentHookNum,
				"callback": callback
			});
		};

		this.remove = (cmd, id) => {
			if(Array.isArray(cmd)) {
				for(let i in cmd) this.remove(cmd[i], id);
				return;
			}

			if(!id || !cmd) return console.error(`Invalid id for removal on command ${cmd}`);

			for(let idx in hooks[cmd] || []) {
				if(hooks[cmd][idx].id === id) return hooks[cmd].slice(idx, 1);
			}
		};

		this.message = (msg) => {
			if(!msg) return;

			for(let i = msg.length - 1; i > 0; i--) {
				if(REPLACE_SYMBOLS_ON_MESSAGE[msg[i]]) {
					msg = msg.slice(0, i) + REPLACE_SYMBOLS_ON_MESSAGE[msg[i]] + msg.slice(i + 1);
				}
			}

			dispatch.toClient('S_PRIVATE_CHAT', 1, {
				channel: PRIVATE_CHANNEL_ID,
				authorID: 0,
				authorName: config.authorName,
				message: msg
			});
		};

		this.exec = (str, requiresPrefix=true) => {
			str = parseString(str);
			let data = getStringCommandInfo(str, requiresPrefix);
			if(data.length) {
				// Case insensitivity \o/
				let cmd = data[0].toLowerCase();
				data.splice(0, 1);

				for(let idx in hooks[cmd]) {
					try {
						hooks[cmd][idx].callback(...data);
					}catch(e) {
						console.log(e);
						this.message(`Error on command ${cmd}`);
						this.message(e);
					}
				}
				return false;
			}
			return true;
		};


		/** Helper functions **/
		function parseString(str) {
			return stripFont(str);
		}

		function getStringCommandInfo(str, requiresPrefix) {
			let arr = parseArgs(str);
			if(!arr || arr.length === 0) return [];

			// Check for prefix
			let prefixInfo = { found: false, prefix: "" };
			for(let prefix of config.commandPrefixes) {
				if(arr[0].indexOf(prefix) === 0) prefixInfo = {found: true, prefix};
			}

			if(prefixInfo.found) {
				arr[0] = arr[0].replace(prefixInfo.prefix, '');
			}else if(requiresPrefix) return [];

			return arr;
		}

		/** Packet handling **/
		/** Handle chat **/
		this.messagePacket = (e) => {
			if(e.channel == 11 + PRIVATE_CHANNEL_INDEX) {
				this.exec(e.message, false);
				return false;
			}else if(config.public_enable) {
				return this.exec(e.message, true);
			}
		};

		dispatch.hook('C_CHAT', 1, DEFAULT_HOOK_SETTINGS_ON_CHAT, this.messagePacket);
		dispatch.hook('C_WHISPER', 1, DEFAULT_HOOK_SETTINGS_ON_CHAT, this.messagePacket);

		// Wrapping this in a try statement due to potential missing opcodes
		try{
			dispatch.hook('C_OP_COMMAND', 1, e=> this.exec(e.cmd, false));
			dispatch.hook('C_ADMIN', 1, e=> this.exec(e.command, false));
		}catch(e) {}

		/** Handle misc **/

		// Set Loaded on login
		dispatch.hook('S_LOGIN', ()=> { loaded = false; });

		// Join channel
		this.__joinChannel = () => {
			dispatch.toClient('S_JOIN_PRIVATE_CHANNEL', 1, {
				index: PRIVATE_CHANNEL_INDEX,
				id: PRIVATE_CHANNEL_ID,
				unk: [],
				name: config.private_channel_name
			});
			if(config.login_message) {
				this.message(`TERA Proxy enabled. Client version: ${dispatch.base.protocolVersion}. Patch version: ${dispatch.base.majorPatchVersion}`);
			}
		}

		dispatch.hook('S_LOAD_CLIENT_USER_SETTING', ()=> {
			if(!loaded) {
				loaded = true;
				process.nextTick(this.__joinChannel);
			}
		});

		// Silence packets if we're using them for this module
		this.__silenceChannelPacket = (e) => e.index !== PRIVATE_CHANNEL_INDEX;
		dispatch.hook('S_JOIN_PRIVATE_CHANNEL', 1, this.__silenceChannelPacket);
		dispatch.hook('C_LEAVE_PRIVATE_CHANNEL', 1, this.__silenceChannelPacket);

		// Reply to the packet for our channel
		dispatch.hook('C_REQUEST_PRIVATE_CHANNEL_INFO', 1, e=> {
			if(e.channelId === PRIVATE_CHANNEL_ID) {
				dispatch.toClient('S_REQUEST_PRIVATE_CHANNEL_INFO', 1, {
					owner: 1,
					password: 0,
					members: [],
					friends: []
				});
				return false;
			}
		});

		// Hook our own command \o/
		this.add(config.showCommandsCommands, ()=> {
			for(let key in hooks) {
				this.message(`Command: ${key}`);
			}
		}, "Kasea is a genius.");
	}
}

function stripFont(str) {
	str = str.replace('</FONT>', '');
	return str.replace('<FONT>', '');
}

function parseArgs(str) {
	let args = [];
	let arg = '';
	let quote = '';

	let parseHTML = /.*?<\/.*?>/g;

	for(let i = 0, c = ''; i < str.length; i++) {
		c = str[i];

		switch(c) {
			case '<':
				parseHTML.lastIndex = i + 1;

				let len = parseHTML.exec(str);

				if(!len) throw new Error('HTML parsing failure');

				len = len[0].length;
				arg += str.substr(i, len + 1);
				i += len;
				break;
			case '\\':
				c = str[++i];

				if(c === undefined) throw new Error('Unexpected end of line');

				arg += c;
				break;
			case '\'':
			case '"':
				if(arg === '' && quote === '') {
					quote = c;
					break;
				}
				if(quote === c) {
					quote = '';
					break;
				}
				arg += c;
				break;
			case ' ':
				if(quote === '') {
					if(arg !== '') {
						args.push(arg);
						arg = '';
					}
					break;
				}
			default:
				arg += c;
		}
	}

	if(arg !== '') {
		if(quote !== '') throw new Error('Expected ' + quote);

		args.push(arg);
	}

	return args;
}

let map = new WeakMap();

module.exports = function Require(dispatch) {
	if(map.has(dispatch.base)) return map.get(dispatch.base);

	let command = new Command(dispatch);
	map.set(dispatch.base, command);
	return command;
}