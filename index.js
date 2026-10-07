const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, generateWAMessageFromContent, getUrlInfo } = require('@whiskeysockets/baileys');
const P = require('pino');
const crypto = require('crypto');

const PREFIX = '.';
const PHONE_NUMBER = '233206391674'; 
const IMAGE_URL = 'https://i.postimg.cc/g0rbSQPs/Screenshot-20261007-032200-Whats-App.jpg';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: P({ level: 'silent' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered) {
        console.log('⏳ Starting connection. Preparing to request pairing code...');
        // Wait 5 seconds for the socket to be fully ready
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log('\n======================================');
                console.log('  YOUR PAIRING CODE:  ' + code);
                console.log('======================================\n');
                console.log('👉 1. Open WhatsApp on your phone');
                console.log('👉 2. Settings → Linked Devices → Link a Device');
                console.log('👉 3. Tap "Link with phone number instead"');
                console.log('👉 4. Type the code ABOVE IMMEDIATELY.\n');
            } catch (err) {
                console.log('\n❌ Failed to get pairing code.');
                console.log('   Error details: ' + err.message);
            }
        }, 5000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') console.log('\n✅ Bot connected and ready!\n');
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) { 
                console.log('Reconnecting in 5 seconds...'); 
                setTimeout(() => startBot(), 5000); 
            } else {
                console.log('❌ Logged out. Delete auth_info and run again.');
            }
        }
    });

    async function sendGroupStatus(jid, text, preview) {
        const messageSecret = crypto.randomBytes(32);
        const extendedTextMessage = { text: text, contextInfo: { isGroupStatus: true } };
        if (preview) {
            extendedTextMessage.canonicalUrl = preview['canonical-url'];
            extendedTextMessage.matchedText = preview['matched-text'];
            extendedTextMessage.title = preview.title;
            extendedTextMessage.description = preview.description;
            if (preview.jpegThumbnail) extendedTextMessage.jpegThumbnail = preview.jpegThumbnail;
        }
        const msg = generateWAMessageFromContent(jid, {
            messageContextInfo: { messageSecret },
            groupStatusMessageV2: { message: { extendedTextMessage, messageContextInfo: { messageSecret } } },
        }, {});
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        if (!from) return;
        const isGroup = from.endsWith('@g.us');
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        if (!text.startsWith(PREFIX)) return;

        const trimmed = text.slice(PREFIX.length).trim();
        const spaceIdx = trimmed.search(/\s/);
        const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx).toLowerCase();
        const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx).trim();
        if (!rest) return;

        console.log(`\n📥 Command: ${cmd}`);

        let preview = null;
        const urlMatch = rest.match(/https?:\/\/\S+/);
        const link = urlMatch ? urlMatch[0] : null;

        if (link) {
            try {
                const info = await getUrlInfo(link);
                if (info) {
                    preview = {
                        'canonical-url': info.url,
                        'matched-text': link,
                        title: info.title || '',
                        description: info.description || '',
                        jpegThumbnail: info.jpegThumbnail || undefined,
                    };
                }
            } catch (e) { }
        }

        if ((cmd === 'status' || cmd === 'gstatus') && isGroup) {
            try {
                const metadata = await sock.groupMetadata(from);
                await sendGroupStatus(from, rest, preview);
                await sock.sendMessage(from, { text: `✅ Group status posted to *${metadata.subject}*` });
            } catch (err) {
                await sock.sendMessage(from, { text: '❌ Status Failed: ' + err.message });
            }
        }
        else if (cmd === 'statusall' || cmd === 'gstatusall') {
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupJids = Object.keys(groups);
                await sock.sendMessage(from, { text: `📤 Posting status to ${groupJids.length} groups...` });
                for (const jid of groupJids) {
                    try { await sendGroupStatus(jid, rest, preview); } catch (e) { }
                    await new Promise(r => setTimeout(r, 3000));
                }
                await sock.sendMessage(from, { text: '🎉 Done posting status to all groups.' });
            } catch (err) { }
        }
        else if (cmd === 'send' && isGroup) {
            try {
                await sock.sendMessage(from, { image: { url: IMAGE_URL }, caption: rest });
            } catch (err) { }
        }
        else if (cmd === 'sendall') {
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupJids = Object.keys(groups);
                await sock.sendMessage(from, { text: `📤 Sending message to ${groupJids.length} groups...` });
                for (const jid of groupJids) {
                    try { await sock.sendMessage(jid, { image: { url: IMAGE_URL }, caption: rest }); } catch (e) { }
                    await new Promise(r => setTimeout(r, 3000));
                }
                await sock.sendMessage(from, { text: '🎉 Done sending message to all groups.' });
            } catch (err) { }
        }
    });
}

startBot();
