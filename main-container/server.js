const REDIS_NAMESPACE = 'multibot';
const PREDIS = REDIS_NAMESPACE + ':';

import redis from 'redis';
import http from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import passport from 'passport';
import { OAuth2Strategy } from 'passport-oauth';
import fs from 'fs';
import handlebars from 'handlebars';
import k8s from '@kubernetes/client-node';
import yaml from 'js-yaml';

const kc = new k8s.KubeConfig();
kc.loadFromCluster();

const appsV1Api = kc.makeApiClient(k8s.AppsV1Api);
const coreV1Api = kc.makeApiClient(k8s.CoreV1Api);

function load_tenant_yaml(channel) {
    return fs.readFileSync('tenant-container.yaml')
        .toString('utf-8')
        .replaceAll('{{IMAGE}}', process.env.DOCKER_USERNAME + '/multibot-tenant:latest')
        .replaceAll('{{IMAGE_PULL_POLICY}}', process.env.IMAGE_PULL_POLICY)
        .replaceAll('{{CHANNEL}}', channel)
        .split('---')
        .map(text => yaml.load(text));
}

async function create_tenant_container(channel) {
    const [deployment, service] = load_tenant_yaml(channel);

    let worked = true;
    try {
        console.log('creating deployment...');
        const deployment_res = await appsV1Api.createNamespacedDeployment(deployment.metadata.namespace, deployment);
        console.log('created deployment:', deployment_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    try {
        console.log('creating service...');
        const service_res = await coreV1Api.createNamespacedService(service.metadata.namespace, service);
        console.log('created service:', service_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    return worked;
}

async function delete_tenant_container(channel) {
    const [deployment, service] = load_tenant_yaml(channel);

    let worked = true;
    try {
        console.log('deleting deployment...');
        const deployment_res = await appsV1Api.deleteNamespacedDeployment(deployment.metadata.name, deployment.metadata.namespace);
        console.log('deleted deployment:', deployment_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    try {
        console.log('deleting service...');
        const service_res = await coreV1Api.deleteNamespacedService(service.metadata.name, service.metadata.namespace);
        console.log('deleted service:', service_res.body);
    } catch (err) {
        worked = false;
        console.error(err.body);
    }
    return worked;
}


const redis_client = redis.createClient({
    url: process.env.STATE_DB_URL,
    password: process.env.STATE_DB_PASSWORD,
});
redis_client.on('error', err => console.log('Redis Client Error', err));

const proxy_overrides = JSON.parse(process.env.PROXY_OVERRIDES ?? '{}');
(async () => {
    await redis_client.connect();
    for (const channel in proxy_overrides) {
        await redis_client.sAdd(`${PREDIS}channels`, channel);
    }
    const channels = await redis_client.sMembers(`${PREDIS}channels`);
    console.log('channels onboarded:', channels);
    for (const channel of channels) {
        //don't await, start them in parallel
        create_tenant_container(channel);
    }
})();


// Initialize Express and middlewares
const app = express();
const server = http.createServer(app);

// for consideration of using channel URLs directly, and having non-channel URLs be invalid usernames:
// Your Twitch username must be between 4 and 25 characters—no more, no less. Secondly, only letters A-Z, numbers 0-9, and underscores (_) are allowed. All other special characters are prohibited, but users are increasingly calling for the restriction to be relaxed in the future.
// need to make sure non-channel URLs contain a "-" or are 3 chars long, e.g. "/twitch-auth", "/log-out", "/new", "/api", etc.
// if owncast is added as a primary login, make sure that the url has a "." in it, e.g. "jjv.sh" to distinguish it from twitch

//credit to https://github.com/twitchdev/authentication-node-sample (apache 2.0 license) for the auth code
const CALLBACK_URL = process.env.BASE_URL + '/api/auth/twitch/callback';
app.use(session({
    store: new RedisStore({ client: redis_client, prefix: PREDIS + 'sessions/' }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Set to true if using HTTPS
        // maxAge: 1000 * 60 * 1 // Session expiration time (1min)
    }
}));
// app.use(express.static('public'));
app.use(passport.initialize());
app.use(passport.session());

function is_super_admin(username) {
    return username?.toLowerCase() === process.env.TWITCH_SUPER_ADMIN_USERNAME.toLowerCase();
}

// Override passport profile function to get user profile from Twitch API
OAuth2Strategy.prototype.userProfile = function (accessToken, done) {
    fetch('https://api.twitch.tv/helix/users', {
        method: 'GET',
        headers: {
            'Client-ID': process.env.TWITCH_CLIENT_ID,
            'Accept': 'application/vnd.twitchtv.v5+json',
            'Authorization': 'Bearer ' + accessToken
        }
    })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => Promise.reject(err));
            }
            return response.json();
        })
        .then(data => {
            done(null, data);
        })
        .catch(error => {
            done(error);
        });
};

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
        console.log(`[twitch] user "${user.login}" logged in to the web interface with twitch`);
        // console.log(user);
        done(null, user);
    }
));

// Set route to start OAuth link, this is where you define scopes to request
app.get('/api/auth/twitch', passport.authenticate('twitch', { scope: ['user_read'] }));

// Set route for OAuth redirect
app.get('/api/auth/twitch/callback', passport.authenticate('twitch', { failureRedirect: '/' }), async function (req, res) {
    const login = req.session?.passport?.user?.login
    if (await redis_client.sIsMember(`${PREDIS}channels`, login)) {
        //if the channel has a tenant container, go there
        res.redirect('/' + login);
    } else {
        //otherwise go to the homepage which has instructions to sign up
        res.redirect('/');
    }
});

function channel_auth_middleware(req, res, next) {
    const login = req.session?.passport?.user?.login;
    const channel = req.params.channel; //channel must be a url param for this to work
    if (login === channel || is_super_admin(login)) {
        console.log('auth success', req.originalUrl, req.body, login, is_super_admin(login));
        next();
    } else {
        console.error('access denied', req.originalUrl, req.body, login, is_super_admin(login));
        res.status(403).end(); //403 Forbidden
    }
}

app.get('/api/onboard/', async function (req, res) {
    res.status(400).send('missing channel'); //400 Bad Request
});

app.get('/api/onboard/:channel', channel_auth_middleware, async function (req, res) {
    const channel = req.params.channel;
    if (!channel) {
        res.status(400).send('invalid channel'); //400 Bad Request
        return;
    }
    if (await redis_client.sIsMember(`${PREDIS}channels`, channel)) {
        res.status(409).send('channel already onboarded'); //409 Conflict
        return;
    }
    if (!await create_tenant_container(channel)) { //spin up the container and route
        res.status(500).send('error creating tenant'); //500 Internal Server Error
        return;
    }
    await redis_client.sAdd(`${PREDIS}channels`, channel); //add it to the list of channels in redis
    console.log('onboarded', channel);
    res.send('ok');
});

app.get('/api/offboard/', async function (req, res) {
    res.status(400).send('missing channel'); //400 Bad Request
});

app.get('/api/offboard/:channel', channel_auth_middleware, async function (req, res) {
    const channel = req.params.channel;
    if (!channel) {
        res.status(400).send('invalid channel'); //400 Bad Request
        return;
    }
    if (!await redis_client.sIsMember(`${PREDIS}channels`, channel)) {
        res.status(409).send('channel not onboarded'); //409 Conflict
        return;
    }
    if (!await delete_tenant_container(channel)) { //delete the container and route
        res.status(500).send('error deleting tenant'); //500 Internal Server Error
        return;
    }
    await redis_client.del(`${PREDIS}channels/${channel}/channel_props/did_first_run`); //remove the first run prop so it will execute the first run again if onboarded
    await redis_client.sRem(`${PREDIS}channels`, channel); //remove it from the list of channels in redis
    console.log('offboarded', channel);
    res.send('ok');
});

app.get('/api/logout', function (req, res, next) {
    req.logout(function (err) {
        if (err) { return next(err); }
        res.redirect('/' + (req.query.returnTo ?? ''));
    });
});

//expose js libraries to client so they can run in the browser
app.use('/vue.js', express.static('node_modules/vue/dist/vue.esm-browser.prod.js'));
app.use('/favicon.ico', express.static('favicon.ico'));
app.use('/favicon.png', express.static('favicon.png'));
app.use('/api/fonts/cabin', express.static('node_modules/@fontsource/cabin'));

// Define a simple template to safely generate HTML with values from user's profile
const template = handlebars.compile(fs.readFileSync('index.html', 'utf8'));

// If user has an authenticated session, display it, otherwise display link to authenticate
app.get('/', async function (req, res) {
    const user = req.session?.passport?.user;
    res.send(template({
        channels: await redis_client.sMembers(`${PREDIS}channels`),
        is_super_admin: is_super_admin(user?.login),
        user: user,
    }));
});

//create separate routes for proxy overrides, only used locally
for (const channel in proxy_overrides) {
    const url = proxy_overrides[channel];
    console.log('[proxy override]', channel, url);
    app.use('/' + channel, createProxyMiddleware({
        target: url,
        changeOrigin: false,
        ws: true,
    }));
}

app.use('/:channel', createProxyMiddleware({
    target: '', // Placeholder target
    changeOrigin: false,
    ws: true,
    router: (req) => {
        // console.log('[router]', req.baseUrl, req.url, req.originalUrl, req.path);
        //regular packets have baseUrl as /:channel, which we expect, and url as / for some reason, so always prefer to use baseUrl
        //websocket packets have ONLY url, and it is not / but the correct value of /:channel so fall back to that if baseUrl is undefined
        const channel = req.baseUrl?.split('/')[1] || req.url?.split('/')[1];
        return `http://tenant-container-${channel}-svc:8000`;
    },
    // onProxyReqWs: (proxyReq, req, socket) => {
    //     socket.setMaxListeners(20); // Increase the limit to handle more channels
    // },
    on: {
        error: (err, req, res) => {
            const now = + new Date();
            const channel = req.baseUrl?.split('/')[1] || req.url?.split('/')[1];
            console.log('[main] 404', now, 'channel:', channel, 'error:', err.message);
            if (typeof res.status === 'function') {
                res.status(404).send(`<h1>404 - Channel Not Found</h1>
<p>The requested URL was not found on this server.</p>
<p>If this is your username, <a href="/api/auth/twitch">log in</a> and sign up to activate it.</p>
<p>If you have already signed up but still see this page, contact me to troubleshoot.</p>
<p><a href="/">back to homepage</a></p>
<p>[main] timestamp: ${now}</p>`)
            }
        },
    },
}));

//start the http server
server.listen(process.env.PORT ?? 80, () => {
    console.log('listening on *:' + (process.env.PORT ?? 80));
});
