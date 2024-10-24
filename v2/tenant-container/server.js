const DEFAULT_PORT = 8080;
const PORT = process.env.PORT ?? DEFAULT_PORT;
const TWITCH_CHANNEL = process.env.TWITCH_CHANNEL;
const STATE_DB_PASSWORD = process.env.STATE_DB_PASSWORD;
const STATE_DB_URL = process.env.STATE_DB_URL;

import tmi from 'tmi.js'; //twitch chat https://dev.twitch.tv/docs/irc

import redis from 'redis';
import http from 'http';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import fs from 'fs';
import handlebars from 'handlebars';
import bodyParser from 'body-parser';
import ws, { WebSocketServer } from 'ws';

// Initialize Express and middlewares
const app = express();
const jsonParser = bodyParser.json()
const server = http.createServer(app);

const wss = new WebSocketServer({ server })
wss.on('connection', (client) => {
    console.log('Client connected !')
    client.on('message', (msg) => {
        console.log(`Message:${msg}`);
        // broadcast(msg)
    })
})
function broadcast(msg) {
    for (const client of wss.clients) {
        if (client.readyState === ws.OPEN) {
            client.send(msg)
        }
    }
}

const redis_client = redis.createClient({
    url: STATE_DB_URL,
    password: STATE_DB_PASSWORD
});

redis_client.on('error', err => console.log('Redis Client Error', err));
(async () => {
    await redis_client.connect();
    // await redis_client.set('key', 'value');
    // const value = await redis_client.get('key');
    // console.log('@@@', value);
    await redis_client.sAdd('channels/jjvanvan/chatters', 'JJVanVan');
    // await redis_client.hSet('channels/jjvanvan/chatters/JJVanVan', {'nickname': 'JJ', 'custom_greetz': 'a custom hello to you, #'});
    // console.log('@@@', await redis_client.hGetAll('channels/jjvanvan/chatters/JJVanVan'));
})();


//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
app.use(session({
    store: new RedisStore({ client: redis_client }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        maxAge: 1000 * 60 * 1 // Session expiration time (1min)
    }
}));
// app.use(express.static('public'));


function channel_auth_middleware(req, res, next) {
    const login = req.session?.passport?.user?.login;
    if (login === TWITCH_CHANNEL) { // || is_super_admin(login)) {
        // console.log('auth success', req.body, login, is_super_admin(login));
        next();
    } else {
        // console.error('access denied', req.body, login, is_super_admin(login));
        res.status(403).end(); //403 Forbidden
    }
}


//expose js libraries to client so they can run in the browser
app.use(`/${TWITCH_CHANNEL}/vue.js`, express.static('node_modules/vue/dist/vue.global.prod.js'));

// Define a simple template to safely generate HTML with values from user's profile
const template = handlebars.compile(fs.readFileSync('index.html', 'utf8'));

// If user has an authenticated session, display it, otherwise display link to authenticate
app.get(`/${TWITCH_CHANNEL}`, async function (req, res) { res.send(template({ channel: TWITCH_CHANNEL, channels: await redis_client.sMembers('channels'), user: req.session?.passport?.user })); });
app.get(`/${TWITCH_CHANNEL}/chatters`, async function (req, res) {
    const chatters = await redis_client.sMembers(`channels/${TWITCH_CHANNEL}/chatters`);
    console.log('chatters:', chatters);
    const chatter_data = {};
    for (const chatter of chatters) {
        chatter_data[chatter] = await redis_client.hGetAll(`channels/${TWITCH_CHANNEL}/chatters/${chatter}`);
    }
    console.log('chatter_data:', chatter_data);
    res.send(chatter_data);
});

app.post(`/${TWITCH_CHANNEL}/chatters/:username/nickname/:nickname`, channel_auth_middleware, async function (req, res) {
    const username = req.params.username;
    const nickname = req.params.nickname;
    await redis_client.sAdd(`channels/${TWITCH_CHANNEL}/chatters`, username);
    await redis_client.hSet(`channels/${TWITCH_CHANNEL}/chatters/${username}`, {'nickname': nickname});
    res.send('ok');
});

function send_chat(channel, username, nickname, color, text, emotes, pronouns) {
    if (!emotes) {
        emotes = {};
    }
    // try {
    //     const emotes_3rd_party = find_3rd_party_emotes(channel, text);
    //     emotes = Object.assign(emotes_3rd_party, emotes); //put the original emotes last so they don't get overwritten
    // } catch (err) {
    //     console.error('[emotes] error finding 3rd party emotes:', channel, text, err);
    // }
    const iomsg = { username: username, nickname: nickname, pronouns: pronouns, color: color, emotes: emotes, text: text };
    // if (!chat_history[channel]) {
    //     chat_history[channel] = [];
    // }
    // chat_history[channel].push(iomsg);
    // if (chat_history[channel].length > CHAT_HISTORY_LENGTH) {
    //     chat_history[channel].shift();
    // }
    console.log(`[socket.io] SEND CHAT [${channel}] ${username} (nickname: ${nickname} color: ${color} emotes: ${JSON.stringify(emotes)}): ${text}`);
    // io.emit(channel + '/chat', iomsg);
    broadcast(JSON.stringify(iomsg));
}


//twitch chat stuff
var tmi_client = undefined;

function twitch_try_say(channel, message) {
    if (tmi_client) {
        tmi_client.say(channel, message).catch(error => console.error('[twitch] tmi say error:', error));
    }
}


// Called every time the bot connects to Twitch chat
function onConnectedHandler(addr, port) {
    
}
// Called every time a message comes in
async function onMessageHandler(target, context, msg, self) {
    console.log(`[twitch] TARGET: ${target} SELF: ${self} CONTEXT: ${JSON.stringify(context)}`);
    const username = context['display-name'];
    console.log(`[twitch] ${username}: ${msg}`);
    const channel = target.replace('#', '');

    if (context['message-type'] === 'whisper') {
        return; //ignore whispers
    }

    if (!username) {
        console.error('[twitch] no username in message');
        return; //ignore messages with no username
    }

    const nickname = undefined; //await getViewerProperty(channel, 'nickname', username);

    //forward message to socket chat
    send_chat(channel, username, nickname, context.color, msg, context.emotes, undefined); //getPronouns(username));
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
        channels: [TWITCH_CHANNEL]
    };

    // Create a client with our options
    tmi_client = new tmi.client(opts);

    // Register our event handlers (defined below)
    tmi_client.on('message', onMessageHandler);
    tmi_client.on('connected', (addr, port) => console.log(`[twitch] connected to ${addr}:${port}`));
    // Connect to Twitch:
    tmi_client.connect().catch(error => console.error('[twitch] tmi connect error:', error));
}

(async () => {
    connectToTwitchChat();
})();

//start the http server
server.listen(PORT, () => {
    console.log('listening on *:' + PORT);
});
