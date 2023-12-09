const DEFAULT_PORT = 8080;
const JSON_DB_FILE = '/srv/data.json';
const SECRETS_FILE = '/srv/secret.env';
const CHAT_HISTORY_LENGTH = 100;
const chat_history = {};
const carl_history = {};
const HOUR_IN_MILLISECONDS = 1 * 60 * 60 * 1000;
const DEFAULT_CHANNEL_PROPERTIES = {
    'enabled': false,
    'fwd_cmds_yt_twitch': ['!sr', '!test'],
    'youtube_id': '',
    'max_nickname_length': 20,
    'greetz_threshold': 5 * HOUR_IN_MILLISECONDS,
    'greetz_wb_threshold': 0.75 * HOUR_IN_MILLISECONDS,
    'custom_greetz': {},
    'nickname': {},
}
const DEFAULT_VIEWER_PROPERTIES = {
    'custom_greetz': '',
    'last_seen': undefined,
}
const DEFAULT_BOT_NICKNAME = '🤖';
const YOUTUBE_MAX_MESSAGE_AGE = 10 * 1000; //10 seconds
const YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL = 1 * 60 * 1000; //1 minute
const GREETZ_DELAY_FOR_COMMAND = 2 * 1000; //wait 2 seconds to greet when the user ran a command
const TWITCH_MESSAGE_DELAY = 500; //time to wait between twitch chats for both to go thru
const ENABLED_COOLDOWN = 5 * 1000; //only let users enable/disable their channel every 5 seconds

const GREETZ = [
    'yo #',
    'yo #',
    'yo yo #',
    'yo yo yo #',
    'yo yo yo # whats up!',
    'heyo #',
    'yooo # good to see u',
    'good to see u #',
    'hi #',
    'hello #',
    'helo #',
    'whats up #',
    'hey #, whats up?',
    'welcome #',
    'welcome in, #',
    'greetings #',
    'hows it going #',
    'hey whats new with you #',
    'how have you been #',
];

const GREETZ_ALSO = [
    'also hi #',
    'also hi # whats up!',
    'also its good to see u #',
    'also whats up #',
    'also, whats up #?',
    'also welcome #',
    'also welcome in, #',
    'also welcome to chat, #',
    'also welcome to the stream, #',
    'also hows it going #',
    'also how have you been #',
];


const GREETZ_WELCOME_BACK = [
    'welcome back #',
    'welcome back in, #',
    'welcome back to chat, #',
    'good to see u again #',
    'hello again #',
    'hi again #',
];

const GREETZ_WELCOME_BACK_ALSO = [
    'also welcome back #',
    'also welcome back in, #',
    'also welcome back to chat, #',
    'also good to see u again #',
    'also hello again #',
    'also hi again #',
];

const http = require('http');
const https = require('https');
const dotenv = require('dotenv'); //for storing secrets in an env file
const tmi = require('tmi.js'); //twitch chat https://dev.twitch.tv/docs/irc
const { fetchLivePage } = require("./node_modules/youtube-chat/dist/requests") //get youtube live url by channel id https://github.com/LinaTsukusu/youtube-chat
const { Masterchat, stringify } = require("masterchat"); //youtube chat https://github.com/sigvt/masterchat
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const OAuth2Strategy = require('passport-oauth').OAuth2Strategy;
const request = require('request');
const handlebars = require('handlebars');
const { JsonDB, Config } = require('node-json-db');
const bodyParser = require('body-parser')
// var Filter = require('bad-words'),
// filter = new Filter();
var filter = require('profanity-filter');
filter.seed('profanity');
filter.isProfane = (s) => s !== filter.clean(s);

const RANDOM_NICKNAMES_FILE = '/srv/random-nicknames.txt';
const RANDOM_NICKNAMES = [];

try {
    fs.readFileSync(RANDOM_NICKNAMES_FILE).toString().split("\n").forEach(line => {
        if (line !== '') {
            // console.log(line);
            RANDOM_NICKNAMES.push(line);
        }
    });
    console.log(`loaded ${RANDOM_NICKNAMES.length} random nicknames`)
} catch (err) {
    console.error('error reading ' + RANDOM_NICKNAMES_FILE);
}

dotenv.config({ path: SECRETS_FILE }) //bot API key and other info
const CALLBACK_URL = process.env.BASE_URL + '/auth/twitch/callback';

//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
// Initialize Express and middlewares
const app = express();
const jsonParser = bodyParser.json()
const server = http.createServer(app);
const io = require('socket.io')(server);
app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
app.use(express.static('public'));
app.use(passport.initialize());
app.use(passport.session());

// Override passport profile function to get user profile from Twitch API
OAuth2Strategy.prototype.userProfile = function (accessToken, done) {
    const options = {
        url: 'https://api.twitch.tv/helix/users',
        method: 'GET',
        headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Accept': 'application/vnd.twitchtv.v5+json',
            'Authorization': 'Bearer ' + accessToken
        }
    };

    request(options, function (error, response, body) {
        if (response && response.statusCode == 200) {
            done(null, JSON.parse(body));
        } else {
            done(JSON.parse(body));
        }
    });
}

passport.serializeUser(function (user, done) {
    done(null, user);
});

passport.deserializeUser(function (user, done) {
    done(null, user);
});


passport.use('twitch', new OAuth2Strategy({
    authorizationURL: 'https://id.twitch.tv/oauth2/authorize',
    tokenURL: 'https://id.twitch.tv/oauth2/token',
    clientID: process.env.TWITCH_CLIENT_ID,
    clientSecret: process.env.TWITCH_SECRET,
    callbackURL: CALLBACK_URL,
    state: true
},
    function (accessToken, refreshToken, profile, done) {
        console.log(profile);

        const user = {};
        user.accessToken = accessToken;
        user.refreshToken = refreshToken;
        user.id = profile.data[0].id;
        user.login = profile.data[0].login;
        user.display_name = profile.data[0].display_name;
        user.profile_image_url = profile.data[0].profile_image_url;
        user.created_at = profile.data[0].created_at;
        user.is_super_admin = is_super_admin(user.login);
        console.log(`[twitch] user "${user.login}" logged in to the web interface with twitch`);
        // console.log(user);
        done(null, user);
    }
));

// Set route to start OAuth link, this is where you define scopes to request
app.get('/auth/twitch', passport.authenticate('twitch', { scope: ['user_read'] }));

// Set route for OAuth redirect
app.get('/auth/twitch/callback', passport.authenticate('twitch', { successRedirect: '/', failureRedirect: '/' }));

// Define a simple template to safely generate HTML with values from user's profile
const template = handlebars.compile(fs.readFileSync('index.html', 'utf8'));

// If user has an authenticated session, display it, otherwise display link to authenticate
app.get('/', function (req, res) { res.send(template({ channel: '', user: req.session?.passport?.user })); });
app.get('/chat', (req, res) => { res.send(template({ is_chat_fullscreen: true, channel: req.query.channel, bgcolor: req.query.bgcolor || 'transparent', show_usernames: req.query.show_usernames, show_nicknames: req.query.show_nicknames })) });

app.get('/logout', function (req, res, next) {
    req.logout(function (err) {
        if (err) { return next(err); }
        res.redirect('/' + (req.query.returnTo || ''));
    });
});

//expose js libraries to client so they can run in the browser
app.get('/vue.js', (req, res) => { res.sendFile(__dirname + '/node_modules/vue/dist/vue.global.prod.js') });
app.get('/color-hash.js', (req, res) => { res.sendFile(__dirname + '/node_modules/color-hash/dist/color-hash.js') });
app.use('/tmi-utils', express.static(__dirname + '/node_modules/tmi-utils/dist/esm', { 'extensions': ['js'] })); //add .js if not specified
app.get('/favicon.ico', (req, res) => { res.sendFile(__dirname + '/favicon.ico') });
app.get('/favicon.png', (req, res) => { res.sendFile(__dirname + '/favicon.png') });

//expose the static dir
app.use('/static', express.static('static'));

//expose the list of channels
app.get('/channels', async (req, res) => { res.send(JSON.stringify({ channels: await getEnabledChannels(), all_channels: await getChannels() })) });
app.get('/chat_history', async (req, res) => { res.send(JSON.stringify(chat_history[req.query.channel] || [])) });

function channel_auth_middleware(req, res, next) {
    const login = req.session?.passport?.user?.login;
    if (login === req.body.channel || is_super_admin(login)) {
        console.log('auth success', req.body, login, is_super_admin(login));
        next();
    } else {
        console.error('access denied', req.body);
        res.status(403).end(); //403 Forbidden
    }
}

function better_typeof(data) {
    if (data?.constructor === Array) return 'Array';
    if (data?.constructor === Object) return 'Object';
    return typeof (data); //for example, 'string', 'number', 'undefined', etc.
}

function validate_middleware(param_name, param_types, validator = undefined) {
    if (better_typeof(param_types) !== 'Array') {
        param_types = [param_types];
    }
    return (req, res, next) => {
        const data = req.body[param_name];
        if (param_types.includes(better_typeof(data))) {
            if (!validator || validator(data)) {
                next();
            } else {
                console.error('invalid data, failed validator:', data);
                res.status(400).send('invalid data, failed validator'); //400 Bad Request
            }
        } else {
            console.error('invalid data, expected ' + param_types + ' but got:', data);
            res.status(400).send('invalid data, expected ' + param_types); //400 Bad Request
        }
    }
}

const enabled_timeouts = {
    // 'channel': new Date(),
};
app.post('/enabled', jsonParser, channel_auth_middleware, validate_middleware('enabled', 'boolean'), async (req, res) => {
    const channel = req.body.channel;
    const enabled = req.body.enabled;
    const now = new Date();
    //only allow enabling/disabling every 5 seconds
    if (!enabled_timeouts[channel] || now - enabled_timeouts[channel] > ENABLED_COOLDOWN) {
        enabled_timeouts[channel] = now;
        const old_enabled = await getChannelProperty(channel, 'enabled');
        if (old_enabled !== enabled) {
            await setChannelProperty(channel, 'enabled', enabled);
            if (enabled) {
                if (!await getViewerProperty(channel, 'nickname', process.env.TWITCH_BOT_USERNAME)) {
                    await setViewerProperty(channel, 'nickname', process.env.TWITCH_BOT_USERNAME, DEFAULT_BOT_NICKNAME);
                    send_nickname(channel, process.env.TWITCH_BOT_USERNAME, DEFAULT_BOT_NICKNAME);
                }
                connect_to_youtube(channel);
            } else {
                disconnect_from_youtube(channel);
            }
            connectToTwitchChat();
            send_global_event({ channel: channel, enabled: enabled });
        }
        res.end();
    } else {
        res.send('wait');
    }
});

function add_api_channel_property(property_name, property_types, validator = undefined) {
    app.get('/' + property_name, async (req, res) => { res.send(JSON.stringify(await getChannelProperty(req.query.channel, property_name))) });
    app.post('/' + property_name, jsonParser, channel_auth_middleware, validate_middleware(property_name, property_types, validator), async (req, res) => {
        const channel = req.body.channel;
        const property_value = req.body[property_name];
        await setChannelProperty(channel, property_name, property_value);
        send_event(channel, { [property_name]: property_value });
        res.end();
    });
}

add_api_channel_property('max_nickname_length', 'number', validator = x => x > 0);
add_api_channel_property('fwd_cmds_yt_twitch', 'Array');
add_api_channel_property('greetz_threshold', 'number');
add_api_channel_property('greetz_wb_threshold', 'number');

function add_api_viewer_property(property_name, property_types, validator = undefined) {
    app.get('/' + property_name, async (req, res) => { res.send(JSON.stringify(await getViewerProperty(req.query.channel, property_name, req.query.username))) });
    app.post('/' + property_name, jsonParser, channel_auth_middleware, validate_middleware(property_name, property_types, validator), async (req, res) => {
        const channel = req.body.channel;
        const username = req.body.username;
        const property_value = req.body[property_name];
        await setViewerProperty(channel, property_name, username, property_value);
        send_event(channel, { username: username, [property_name]: property_value });
        res.end();
    });
}

add_api_viewer_property('custom_greetz', 'string');

app.get('/nickname', async (req, res) => { res.send(JSON.stringify(await getViewerProperty(req.query.channel, 'nickname', req.query.username))) });
app.post('/nickname', jsonParser, channel_auth_middleware, validate_middleware('nickname', ['string', 'undefined']), async (req, res) => {
    const channel = req.body.channel;
    const username = req.body.username;
    const nickname = req.body.nickname;
    const caller_display_name = req.session.passport.user.display_name;

    await setViewerProperty(channel, 'nickname', username, nickname);
    send_nickname(channel, username, nickname);
    if (nickname) {
        twitch_try_say(channel, `admin ${caller_display_name} set ${username} 's nickname to ${nickname}`);
    } else {
        await setViewerProperty(channel, 'custom_greetz', username, undefined);
        twitch_try_say(channel, `admin ${caller_display_name} removed ${username} 's nickname`);
    }
    updateChatHistory(channel);
    res.end();
});

app.get('/youtube_id', async (req, res) => { res.send(await getChannelProperty(req.query.channel, 'youtube_id')) });
app.post('/youtube_id', jsonParser, channel_auth_middleware, validate_middleware('youtube_id', 'string'), async (req, res) => {
    const channel = req.body.channel;
    const youtube_id = req.body.youtube_id;
    const old_youtube_id = await getChannelProperty(channel, 'youtube_id');
    if (old_youtube_id !== youtube_id) {
        await setChannelProperty(channel, 'youtube_id', youtube_id);
        connect_to_youtube(channel);
    }
    res.end();
});

app.get('/find_youtube_id', async (req, res) => {
    var channel = req.query.channel; //could be a url or a handle

    console.log('[youtube] looking up', channel);
    if (channel.startsWith('http://www.youtube.com/') || channel.startsWith('http://youtube.com/')) {
        channel = channel.replace('http://', '');
    }
    if (channel.startsWith('www.youtube.com/') || channel.startsWith('youtube.com/')) {
        channel = 'https://' + channel;
    }
    //handle the handle
    if (channel.startsWith('@')) {
        //https://www.youtube.com/@jjvan
        channel = 'https://www.youtube.com/' + channel;
    } else if (!channel.startsWith('https://') && !channel.startsWith('http://')) {
        channel = 'https://www.youtube.com/@' + channel;
    }
    if (channel.startsWith('https://www.youtube.com/channel/') || channel.startsWith('https://youtube.com/channel/') || channel.startsWith('https://www.youtube.com/@') || channel.startsWith('https://youtube.com/@')) {
        const text = await (await fetch(channel)).text();
        // <link rel="canonical" href="https://www.youtube.com/channel/UC3G4BWSWvZZSKAkj-qb7KKQ">
        const regex = /\<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/([^"]*)"\>/
        const match = regex.exec(text);
        if (match) {
            console.log('[youtube] found ID:', match[1], 'for channel:', channel);
            res.send(match[1]);
        } else {
            console.error('[youtube] error finding channel ID for:', channel);
            res.status(500).send('error'); //500 Internal Server Error
        }
    } else {
        console.error('[youtube] invalid URL or handle provided:', channel);
        res.status(400).send('invalid');
    }
});

function getYoutubeStatus(channel) {
    return youtube_chats[channel] || {};
}
app.get('/youtube_status', async (req, res) => { res.send(getYoutubeStatus(req.query.channel)) });


// The first argument is the database filename. If no extension is used, '.json' is assumed and automatically added.
// The second argument is used to tell the DB to save after each push
// If you set the second argument to false, you'll have to call the save() method.
// The third argument is used to ask JsonDB to save the database in a human readable format. (default false)
// The last argument is the separator. By default it's slash (/)
const db = new JsonDB(new Config(JSON_DB_FILE, true, true, '/'));

async function getChannels() {
    try {
        const channels = await db.getData('/channels/');
        return Object.keys(channels);
    } catch (error) {
        return [];
    }
}
async function getEnabledChannels() {
    try {
        const channels = await db.getData('/channels/');
        return Object.keys(channels).filter(k => channels[k].enabled);
    } catch (error) {
        return [];
    }
}

async function getChannelProperty(channel, property_name) {
    try {
        return await db.getData('/channels/' + channel + '/' + property_name);
    } catch (error) {
        return DEFAULT_CHANNEL_PROPERTIES[property_name];
    }
}
async function setChannelProperty(channel, property_name, property_value) {
    return await db.push('/channels/' + channel + '/' + property_name, property_value);
}


async function getViewerProperty(channel, property_name, username) {
    if (username) {
        try {
            return await db.getData('/channels/' + channel + '/' + property_name + '/' + username);
        } catch (error) {
            return DEFAULT_VIEWER_PROPERTIES[property_name];
        }
    } else {
        return await getChannelProperty(channel, property_name);
    }
}
async function setViewerProperty(channel, property_name, username, property_value) {
    if (property_value) {
        await db.push('/channels/' + channel + '/' + property_name + '/' + username, property_value);
    } else {
        await db.delete('/channels/' + channel + '/' + property_name + '/' + username);
    }
}


function random_choice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

async function parse_greetz(stock_greetz_array, channel, username) {
    const nickname = await getViewerProperty(channel, 'nickname', username);
    const custom_greetz = await getViewerProperty(channel, 'custom_greetz', username);
    let message;
    if (custom_greetz) {
        message = custom_greetz;
    } else {
        message = random_choice(stock_greetz_array);
    }
    // return '@' + username + ' ' + message.replaceAll('#', nickname);
    return message.replaceAll('@', '@' + username).replaceAll('#', nickname);
    // return '@' + username + ' ' + message.replaceAll('@', '@' + username).replaceAll('#', nickname);
}


//use socket.io to make a simple live chatroom
io.on('connection', (socket) => {
    console.log('[socket.io] a user connected');
    socket.on('disconnect', () => {
        console.log('[socket.io] a user disconnected');
    });

    //when client sends an 'init' message
    socket.on('init', async (msg) => {
        const channel = msg.channel;
        console.log(`[socket.io] INIT ${channel}`);
    });
});

function send_chat(channel, username, nickname, color, text, emotes) {
    const iomsg = { username: username, nickname: nickname, color: color, emotes: emotes, text: text };
    if (!chat_history[channel]) {
        chat_history[channel] = [];
    }
    chat_history[channel].push(iomsg);
    if (chat_history[channel].length > CHAT_HISTORY_LENGTH) {
        chat_history[channel].shift();
    }
    console.log(`[socket.io] SEND CHAT [${channel}] ${username} (nickname: ${nickname} color: ${color} emotes: ${JSON.stringify(emotes)}): ${text}`);
    io.emit(channel + '/chat', iomsg);
}

function send_nickname(channel, username, nickname) {
    console.log(`[socket.io] SEND NICKNAME [${channel}] ${nickname} = ${username}`);
    io.emit(channel + '/nickname', { username: username, nickname: nickname });
}

function send_event(channel, msg) {
    console.log(`[socket.io] SEND EVENT [${channel}]`, msg);
    io.emit(channel + '/event', msg);
}

function send_global_event(msg) {
    console.log(`[socket.io] SEND GLOBAL EVENT`, msg);
    io.emit('global_event', msg);
}

//twitch chat stuff
var tmi_client = undefined;

function twitch_try_say(channel, message) {
    if (tmi_client) {
        tmi_client.say(channel, message).catch(error => console.error('[twitch] tmi say error:', error));
    }
}

async function connectToTwitchChat() {
    if (tmi_client) {
        tmi_client.disconnect();
    }
    // Define configuration options
    const opts = {
        identity: {
            username: process.env.TWITCH_BOT_USERNAME,
            password: process.env.TWITCH_BOT_OAUTH_TOKEN
        },
        channels: await getEnabledChannels()
    };

    // console.log("[twitch] SECRETS:", JSON.stringify(opts));

    // Create a client with our options
    tmi_client = new tmi.client(opts);

    // Register our event handlers (defined below)
    tmi_client.on('message', onMessageHandler);
    tmi_client.on('connected', onConnectedHandler);
    // Connect to Twitch:
    tmi_client.connect().catch(error => console.error('[twitch] tmi connect error:', error));
}

(async () => {
    connectToTwitchChat();
})();


// Called every time the bot connects to Twitch chat
function onConnectedHandler(addr, port) {
    console.log(`[twitch] connected to ${addr}:${port}`);
}
// Called every time a message comes in
async function onMessageHandler(target, context, msg, self) {
    console.log(`[twitch] TARGET: ${target} SELF: ${self} CONTEXT: ${JSON.stringify(context)}`);
    const username = context['display-name'];
    console.log(`[twitch] ${username}: ${msg}`);
    const channel = target.replace('#', '');

    // Ignore whispers
    if (context["message-type"] === "whisper") { return; }

    const nickname = await getViewerProperty(channel, 'nickname', username);

    //forward message to socket chat
    send_chat(channel, username, nickname, context.color, msg, context.emotes);

    if (self) { return; } // Ignore messages from the bot
    const [valid_command, carl_command] = await handleCommand(target, context, msg, username);

    //keep track of when the last message was
    if (username.toLowerCase() !== process.env.TWITCH_BOT_USERNAME.toLowerCase()) {
        if (nickname !== undefined) {
            if (!carl_command) { //carl already replies, no need for double
                const lastSeen = await getViewerProperty(channel, 'lastseen', username);
                const now = + new Date();
                console.log('[greetz]', username, now - lastSeen);
                if (lastSeen === undefined || now - lastSeen > await getChannelProperty(channel, 'greetz_threshold')) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a long time, but issued a command, so sending initial greeting in a few seconds');
                        setTimeout(async () => {
                            twitch_try_say(target, await parse_greetz(GREETZ_ALSO, channel, username));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a long time, sending initial greeting');
                        twitch_try_say(target, await parse_greetz(GREETZ, channel, username));
                    }
                } else if (lastSeen === undefined || now - lastSeen > await getChannelProperty(channel, 'greetz_wb_threshold')) {
                    if (valid_command) { //if the user was running a command, wait a few seconds, then greet them, but with an "also" added
                        console.log('[greetz] user has been away a short time, but issued a command, so sending welcome back greeting in a few seconds');
                        setTimeout(async () => {
                            twitch_try_say(target, await parse_greetz(GREETZ_WELCOME_BACK_ALSO, channel, username));
                        }, GREETZ_DELAY_FOR_COMMAND);
                    } else {
                        console.log('[greetz] user has been away a short time, sending welcome back greeting');
                        twitch_try_say(target, await parse_greetz(GREETZ_WELCOME_BACK, channel, username));
                    }
                }
            }
            setViewerProperty(channel, 'lastseen', username, + new Date());
        }
    }
}

function is_super_admin(username) {
    return username?.toLowerCase() === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase();
}

function has_permission(context) {
    return is_super_admin(context?.username) || context?.badges?.broadcaster === '1' || context?.badges?.moderator === '1';
}

async function getNicknameMsg(channel, username) {
    const nickname = await getViewerProperty(channel, 'nickname', username);
    if (nickname === undefined) {
        if (filter.isProfane(username)) {
            return `that user has not set a nickname yet (with !setnickname)`;
        } else {
            return `user ${username} has not set a nickname yet (with !setnickname)`;
        }
    }
    return `${username} 's nickname is ${nickname}`;
}

async function getUsername(channel, nickname) {
    const nicknames = await getChannelProperty(channel, 'nickname');
    let found = undefined;
    Object.keys(nicknames).forEach(username => {
        if (nicknames[username] === nickname) {
            found = username;
        }
    });
    return found;
}

async function getUsernameMsg(channel, nickname) {
    const username = await getUsername(channel, nickname);
    if (username === undefined) {
        if (filter.isProfane(nickname)) {
            return `that nickname does not belong to anyone, and furthermore is profane and cannot be used`;
        } else {
            return `nickname "${nickname}" does not belong to anyone (claim it with !setnickname)`;
        }
    }
    return `${nickname} is the nickname for ${username}`;
    // return `${username} 's nickname is ${nickname}`;
}

async function nicknameAlreadyTaken(channel, nickname) {
    const nicknames = Object.values(await getChannelProperty(channel, 'nickname'));
    return nicknames.includes(nickname);
}

async function updateChatHistory(channel) {
    if (chat_history[channel]) {
        const nicknames = await getChannelProperty(channel, 'nickname');
        chat_history[channel].forEach(msg => {
            msg.nickname = nicknames[msg.username];
        });
    }
}

async function handleCommand(target, context, msg, username) {
    // Remove whitespace and 7TV bypass from chat message
    const command = msg.replaceAll(' 󠀀', '').trim();
    const channel = target.replace('#', '');

    var valid = true;
    var carl = false;
    // If the command is known, let's execute it
    if (command === '!help' || command === '!commands') {
        twitch_try_say(target, `commands: !botpage - link to the page with nicknames and other info; !multichat - link to the combined youtube/twitch chat; !clear - clear the multichat; !setnickname - set your nickname; !nickname - view your nickname; !nickname user - view another user's nickname; !username nickname - look up who owns a nickname; !unsetnickname - delete your nickname`);
    } else if (command === '!botpage') {
        twitch_try_say(target, `see the nicknames and other bot info at ${process.env.BASE_URL}/${target}`);
    } else if (command === '!multichat') {
        twitch_try_say(target, `see the multichat at ${process.env.BASE_URL}/chat?channel=${channel} and even add it as an OBS browser source`);
        // } else if (command === '!ytconnect') {
        //     if (has_permission(context)) {
        //         const result = await connect_to_youtube(channel);
        //         console.log('[youtube] ytconnect result:', result);
        //         if (result === 'no id') twitch_try_say(channel, `no youtube account linked, log in with twitch here to add your youtube channel: ${process.env.BASE_URL}/${target}`);
        //         if (result === 'no live') twitch_try_say(channel, 'failed to find youtube livestream on your channel: youtube.com/channel/' + await getChannelProperty(channel, 'youtube_id') + '/live');
        //     }
        // } else if (command === '!ytdisconnect') {
        //     if (has_permission(context)) {
        //         disconnect_from_youtube(channel);
        //     }
    } else if (command === '!clear') {
        if (has_permission(context)) {
            clear_chat(channel);
        }
    } else if (command === '!nickname') { //retrieve the nickname of the user who typed it
        twitch_try_say(target, await getNicknameMsg(channel, username));
    } else if (command.startsWith('!nickname ')) { //retrieve a nickname for a specific user
        const lookup_username = command.replace('!nickname', '').trim();
        twitch_try_say(target, await getNicknameMsg(channel, lookup_username));
    } else if (command.startsWith('!username ')) { //retrieve a username based on a nickname
        const nickname = command.replace('!username', '').trim();
        twitch_try_say(target, await getUsernameMsg(channel, nickname));
    } else if (command === '!unsetnickname') {
        const nickname = await getViewerProperty(channel, 'nickname', username);
        if (nickname) {
            await setViewerProperty(channel, 'nickname', username, undefined); //delete the nickname
            send_nickname(channel, username, undefined);
            updateChatHistory(channel);
            twitch_try_say(target, `@${username} removed nickname, sad to see you go`);
        } else {
            twitch_try_say(target, `@${username} you already don't have a nickname`);
        }
    } else if (command === '!setnickname') {
        const used_nicknames = Object.values(await getViewerProperty(channel, 'nickname', undefined));
        console.log(used_nicknames);
        const remaining_random_nicknames = JSON.parse(JSON.stringify(RANDOM_NICKNAMES)).filter(nickname => !used_nicknames.includes(nickname));
        if(remaining_random_nicknames.length > 0) {
            const nickname = random_choice(remaining_random_nicknames);
            await setViewerProperty(channel, 'nickname', username, nickname);
            send_nickname(channel, username, nickname);
            updateChatHistory(channel);
            twitch_try_say(target, `@${username} no nickname provided, your random nickname is ${nickname}`);
        } else {
            twitch_try_say(target, `out of random nicknames to assign, please provide a nickname with the !setnickname command`);
        }
    } else if (command.startsWith('!setnickname ')) {
        const nickname = command.replace('!setnickname', '').trim();
        const max_nickname_length = await getChannelProperty(channel, 'max_nickname_length')
        if (filter.isProfane(nickname)) {
            twitch_try_say(target, `@${username} no profanity allowed in nickname, use a different one or ask the streamer/admin to log in to the link at !botpage and set it for you`);
        } else if (await getViewerProperty(channel, 'nickname', username) === nickname) {
            twitch_try_say(target, `@${username} you already have that nickname`);
        } else if (nickname.length > max_nickname_length) {
            twitch_try_say(target, `@${username} nickname "${nickname}" is too long, must be ${max_nickname_length} letters`);
        } else if (await nicknameAlreadyTaken(channel, nickname)) {
            twitch_try_say(target, `@${username} nickname "${nickname}" is already taken, see !botpage for the list`);
        } else {
            await setViewerProperty(channel, 'nickname', username, nickname);
            send_nickname(channel, username, nickname);
            updateChatHistory(channel);
            twitch_try_say(target, `@${username} set nickname to ${nickname}`);
        }
    } else if (command.includes(`@${process.env.TWITCH_BOT_USERNAME}`) || command.includes(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase())) {
        const message = command
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME} `, '')
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME}`, '')
            .replaceAll(` @${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME} `, '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME} `.toLowerCase(), '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME}`, '')
            .replaceAll(`@${process.env.TWITCH_BOT_USERNAME}`.toLowerCase(), '');
        console.log(`[bot] asking CARL: ${message}`);
        let url = 'https://games.johanv.net/carl_api?user=' + encodeURIComponent(message);
        const reply_parent = context['reply-parent-msg-body'];
        if (reply_parent) {
            const carl_said = carl_history[reply_parent];
            if (carl_said) {
                url = 'https://games.johanv.net/carl_api?carl=' + encodeURIComponent(carl_said) + '&user=' + encodeURIComponent(message);
                console.log(`[bot] found reply parent in carl_history: "${reply_parent}" => ${carl_said}`);
            }
        }
        const response = await fetch(url);
        const data = await response.text();
        if (response.status === 200) {
            console.log("[bot] CARL:", data);
            let display_data = data;
            if (data.includes('CARL') || data.includes('Carl') || data.includes('carl')) {
                const nickname = await getViewerProperty(channel, 'nickname', username);
                display_data = data.replaceAll('CARL', nickname).replaceAll('Carl', nickname).replaceAll('carl', nickname);
                console.log("[bot] CARL (edited): ", display_data);
            }
            if (filter.isProfane(display_data) || display_data.toLowerCase().includes('stupid') || display_data.toLowerCase().includes('dumb') || display_data.toLowerCase().includes('idiot')) {
                display_data = `<3`;
            }
            const reply = `@${username} ${display_data}`
            twitch_try_say(target, reply);
            carl_history[reply] = data;
            console.log(`[bot] saved to carl_history: "${reply}" => "${data}"`);
        } else {
            console.log('[bot] error', response.status, data);
            twitch_try_say(target, `@${username} hey <3`);
        }
        carl = true;
    } else {
        valid = false;
        console.log(`[bot] Unknown command: ${command}`);
    }

    if (valid) {
        console.log(`[bot] Executed command: ${command}`);
    }
    return [valid, carl];

}

async function clear_chat(channel) {
    chat_history[channel] = [];
    console.log(`[socket.io] CLEAR CHAT ${channel}`);
    io.emit(channel + '/chat', { clear_chat: true });
}


//youtube chat stuff
async function getLiveVideoId(youtube_id) {
    try {
        return (await fetchLivePage({ channelId: youtube_id })).liveId;
    } catch (error) {
        // console.error(error);
        return '';
    }
}

const youtube_chats = {
    // 'jjvantheman': { 
    //     youtube_id: 'UCmrLaVZneWG3kJyPqp-RFJQ',
    //     listener: await Masterchat.init("IKRQQAMYnrM"),
    // }
};

async function disconnect_from_youtube(channel) { //channel is a twitch channel
    if (youtube_chats[channel]) {
        youtube_chats[channel].listener.stop();
        delete youtube_chats[channel];
    }
}

async function connect_to_youtube(channel) { //channel is a twitch channel
    disconnect_from_youtube(channel);
    const youtube_id = await getChannelProperty(channel, 'youtube_id');
    if (!youtube_id) {
        console.error('[youtube] no channel id associated with twitch channel ' + channel);
        return 'no id';
    }

    const liveVideoId = await getLiveVideoId(youtube_id);
    console.log(`[youtube] channel: ${channel} youtube_id: ${youtube_id} liveVideoId: ${liveVideoId}`);
    if (liveVideoId === '') {
        console.error('[youtube] falied to find livestream');
        return 'no live';
    }
    console.log(`[youtube] connected to youtube chat: youtu.be/${liveVideoId}`);
    //delay the message a bit to allow the disconnect message to come thru first
    setTimeout(() => twitch_try_say(channel, `connected to youtube chat: youtu.be/${liveVideoId}`), TWITCH_MESSAGE_DELAY);

    const mc = await Masterchat.init(liveVideoId);
    // Listen for live chat
    mc.on("chat", async (chat) => {
        const timestamp = new Date(chat.timestamp);
        const now = new Date();
        const message_age = now - timestamp;
        // console.log(message_age);
        if (message_age <= YOUTUBE_MAX_MESSAGE_AGE) {
            const author = chat.authorName;
            const message = stringify(chat.message);
            console.log(`[youtube] [for twitch.tv/${channel}] ${author}: ${message}`);
            if (message !== undefined) {
                send_chat(channel, author, undefined, undefined, message, undefined);
                const fwd_cmds_yt_twitch = await getChannelProperty(channel, 'fwd_cmds_yt_twitch');
                fwd_cmds_yt_twitch.forEach(command => {
                    if (message.startsWith(command)) {
                        twitch_try_say(channel, filter.clean(message));
                    }
                });

                // twitch_try_say(channel, `[youtube] ${author}: ${message}`);
                // handleCommand(message);
            }
        }
    });

    // Listen for any events
    //   See below for a list of available action types
    mc.on("actions", (actions) => {
        const chats = actions.filter(
            (action) => action.type === "addChatItemAction"
        );
        const superChats = actions.filter(
            (action) => action.type === "addSuperChatItemAction"
        );
        const superStickers = actions.filter(
            (action) => action.type === "addSuperStickerItemAction"
        );
        // ...
    });

    // Handle errors
    mc.on("error", (err) => {
        console.log(`[youtube] [for twitch.tv/${channel}] ${err.code}`);
        // "disabled" => Live chat is disabled
        // "membersOnly" => No permission (members-only)
        // "private" => No permission (private video)
        // "unavailable" => Deleted OR wrong video id
        // "unarchived" => Live stream recording is not available
        // "denied" => Access denied (429)
        // "invalid" => Invalid request
    });

    // Handle end event
    mc.on("end", () => {
        console.log(`[youtube] [for twitch.tv/${channel}] live stream has ended or chat was disconnected`);
        delete youtube_chats[channel];
        twitch_try_say(channel, `disconnected from youtube chat`);
    });

    // Start polling live chat API
    mc.listen();

    youtube_chats[channel] = {
        youtube_id: youtube_id,
        listener: mc,
    }

    return '';
}


async function connect_to_all_youtubes() {
    console.log('[youtube] attempting to connect to all youtube chats');
    (await getEnabledChannels()).forEach(async channel => {
        if (youtube_chats[channel]) {
            console.log('[youtube] already connected to youtube livestream for twitch channel ' + channel);
        } else {
            connect_to_youtube(channel);
        }
    });
}

//periodically attempt to connect to youtube chats
setInterval(connect_to_all_youtubes, YOUTUBE_CHECK_FOR_LIVESTREAM_INTERVAL);


//start the http server
server.listen(process.env.PORT || DEFAULT_PORT, () => {
    console.log('listening on *:' + (process.env.PORT || DEFAULT_PORT));
});


//TODO allow mods to use the admin page for the streamer
//TODO link to source code on the page
//TODO give the bot "watching without audio/video" badge
//TODO merge in the nickname bot
//TODO twitch BTTV, FFZ, 7TV emotes and badges https://github.com/smilefx/tmi-emote-parse
//TODO youtube emotes
//TODO clear chat automatically?
//TODO remove deleted messages (timeouts, bans, individually deleted messages)
//TODO abstract out the sharing of state thru sockets?
//TODO failed to get chat messages after saying it was connected on the 1min timer
//TODO bot missing username when enabled and already has youtube_id ": connected to youtube chat"
//TODO rethink the api paths to something like /api/channels/:channel/nicknames/:username etc.
//TODO better UI for greetz threshold
//TODO owncast chat, then remove it from obs scene
//TODO delete twitch-nicknames-bot repo
//TODO maybe dont save to carl history if replaced with <3
//TODO make emotes slightly larger
//TODO maybe make nickname text slightly smaller
//TODO bot keeps reconnecting to twitch chat, maybe every youtube check?
//TODO bot respond to alerts
//TODO separate vip chat
//TODO args to multichat command to change the link, and tell it in message
//TODO public dashboard page
//TODO keep track of version and if mismatch, send reload request
//TODO auto reload if popout chat or dashboard page, otherwise ask to reload
//TODO commands in the bot's chat to play videos on the 24/7 stream
//TODO a way for super admin to call an api to get/set/delete anything in the database, for example delete last seen time
//TODO add a greetz that is just the nickname + !, such as "DIVINITY!"

/*twitch emote css:

margin: -.5rem 0;
position: relative;
vertical-align: middle;
border: none;
max-width: 100%;
font: inherit;
padding: 0;
box-sizing: border-box;

overflow-wrap: anywhere;

*/
