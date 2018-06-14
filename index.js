const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
    "private_channel_name": "Proxy",
    "login_message": true,
    "public_enable": true,
    "commandPrefixes": ["!", ".", "$"],
    "authorName": "",
	"showCommandsCommands": ["commands", "cmds", "command", "cmd"],
	"streaming_mode": false,
	"enable_streaming_mode_commands": ["streaming"]
};


let config = require('./config.json');
// Config migration -- backwards compatability
config = Object.assign({}, DEFAULT_CONFIG, config);
// Save new config file -- just to be safe
fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(config, null, "    "));

const DEFAULT_HOOK_SETTINGS_ON_CHAT = {order: -15};
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
		this.add = (cmd, callback, id, ctx, moduleName) => {
			if(Array.isArray(cmd)) {
				for(let i in cmd) this.add(cmd[i], callback, id, ctx, moduleName);
				return;
			}

			// Make sure the cmd and callback is defined
			if(!cmd || !callback) return console.error(`Failed to add command ${cmd}.`);

			// if the context is defined, bind the callback with the context
			if(ctx) callback = callback.bind(ctx);

			// Case insensitivity \o/
			cmd = cmd.toLowerCase();
			// If it isn't defined, we add a array for it
			if(!hooks[cmd]) hooks[cmd] = [];

			hooks[cmd].push({
				"id": id || --currentHookNum,
				"callback": callback,
				"name": moduleName
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

		this.message = (...args) => {
			if(!args || args.length === 0 || config.streaming_mode) return;

			let msg = "";
			for(let arg of args) msg += arg + " ";

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
				return !!!hooks[cmd];
			}
			return true;
		};


		/** Helper functions **/
		function parseString(str) {
			return stripFont(str);
		}

		function getStringCommandInfo(str, requiresPrefix) {
			// This can throw an error without proper closing of ", ' etc
			let arr = [];
			try{
				arr = parseArgs(str);
			}catch(e) {}
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
				// If we're handling it return false, however if we're in streaming mode return true(since we want to display it)
				return this.exec(e.message, true) || config.streaming_mode;
			}
		};

		dispatch.hook('C_CHAT', 1, DEFAULT_HOOK_SETTINGS_ON_CHAT, this.messagePacket);
		dispatch.hook('C_WHISPER', 1, DEFAULT_HOOK_SETTINGS_ON_CHAT, this.messagePacket);

		// Wrapping this in a try statement due to potential missing opcodes
		try{
			dispatch.hook('C_OP_COMMAND', 1, e=> this.exec(e.command, false));
			dispatch.hook('C_ADMIN', 1, e=> this.exec(e.command, false));
		}catch(e) {}

		/** Handle misc **/

		// Set Loaded on login
		dispatch.hook('S_LOGIN', 'raw', ()=> { loaded = false; });

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

		// Leave channel
		this.__leaveChannel = () => {
			dispatch.toClient('S_LEAVE_PRIVATE_CHANNEL', 2, {
				channelId: PRIVATE_CHANNEL_ID
			});
		};

		dispatch.hook('S_LOAD_CLIENT_USER_SETTING', 'raw', ()=> {
			if(!loaded) {
				loaded = true;
				if(!config.streaming_mode) process.nextTick(this.__joinChannel);
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
			let sorted = {};
			for(let cmd in hooks) {
				for(let obj of hooks[cmd]) {
					// If it isn't defined
					if(!sorted[obj.name]) sorted[obj.name] = [];
					// Add the command to the array
					sorted[obj.name].push(cmd);
				}
			}

			// Print out everything to chat
			for(let name in sorted) {
				this.message("----", name, "----");
				for(let cmd of sorted[name]) this.message(cmd);
			}
		}, null, null, "command");

		// Hook streaming mode command toggle
		this.add(config.enable_streaming_mode_commands, ()=> {
			config.streaming_mode = !config.streaming_mode;

			// if we enabled it
			if(config.streaming_mode) {
				this.__leaveChannel();
			}
			// if we disabled it
			else {
				this.__joinChannel();
			}
		}, null, null, "command");
	}
}

function stripFont(str) {
	str = str.replace('</FONT>', '');
	let s = str.indexOf('<FONT');
	let e = str.indexOf('>') + 1;
	str = `${str.substring(0, s)}${str.substring(e, str.length)}`;
	return str;
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

class ExportedCommand{
	constructor(dispatch) {
		this.printed = false;
		this._dispatch = dispatch;

		// If the map doesn't exist, create it
		if(!map.has(dispatch.base)) map.set(dispatch.base, new Command(dispatch));
	}

	add(cmd, callback, id, ctx) {
		// This is ugly af, but fucking Just "\_( ^-^ )_/"
		let args = [cmd, callback];
		// If the id is an object, it means it's the context param
		if(typeof id === 'object') {
			args.push(ctx);
			args.push(id);
		// If not, the id is in the correct position
		}else {
			args.push(id);
			args.push(ctx);
		}
		args.push(this._dispatch.moduleName);
		return map.get(this._dispatch.base).add(...args);
	}

	remove(cmd, id) {
		return map.get(this._dispatch.base).remove(cmd, id);
	}

	message(...args) {
		return map.get(this._dispatch.base).message(...args);
	}

	exec(str, requiresPrefix=true) {
		return map.get(this._dispatch.base).exec(str, requiresPrefix);
	}
}

module.exports = function Require(dispatch) {
	return new ExportedCommand(dispatch);
}