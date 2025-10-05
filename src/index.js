import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import QRCode from 'qrcode'
import { WebSocketServer } from 'ws'
import {
  makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion,
  DisconnectReason, jidNormalizedUser
} from '@adiwajshing/baileys'

const app = express()
app.use(cors())
app.use(express.json())

const wss = new WebSocketServer({ noServer: true })
const clients = new Set()
const broadcast = evt => clients.forEach(ws => { try { ws.send(JSON.stringify(evt)) } catch {} })

let sock, currentQR = null

const AUTH = (req, res, next) => {
  const header = (req.headers.authorization || '').replace('Bearer ', '')
  const query = (req.query.token || '').toString()
  const token = header || query
  if (!process.env.API_TOKEN || token !== process.env.API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  next()
}

async function start () {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({ version, auth: state, printQRInTerminal: false })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, qr }) => {
    if (qr) {
      currentQR = await QRCode.toDataURL(qr)
      broadcast({ type: 'session', payload: { state: 'qr', qrBase64: currentQR } })
    }
    if (connection === 'open') {
      currentQR = null
      broadcast({ type: 'session', payload: { state: 'connected' } })
    }
    if (connection === 'close') {
      broadcast({ type: 'session', payload: { state: 'disconnected' } })
      setTimeout(start, 2000)
    }
  })

  sock.ev.on('messages.upsert', ({ messages }) => {
    for (const m of messages) {
      const from = jidNormalizedUser(m.key.remoteJid)
      const text = m.message?.conversation || ''
      broadcast({ type: 'message.in', payload: { from, body: text, ts: Date.now() } })
    }
  })
}
start()

app.get('/qr', AUTH, (req,res)=> currentQR ? res.json({ image: currentQR }) : res.json({ status:'no-qr' }))
app.post('/send', AUTH, async (req,res)=>{
  try {
    const { to, text } = req.body
    if (!to || !text) return res.status(400).json({ error:'to e text obrigatórios' })
    const jid = to.includes('@s.whatsapp.net') ? to : `${to.replace(/\D/g,'')}@s.whatsapp.net`
    await sock.sendMessage(jid, { text })
    res.json({ ok:true })
  } catch(e) { res.status(500).json({ error:'send_failed' }) }
})

const server = app.listen(process.env.PORT || 3000, ()=> console.log('GW on', process.env.PORT||3000))
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (url.searchParams.get('token') !== process.env.API_TOKEN) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws)
    ws.on('close', ()=> clients.delete(ws))
    ws.send(JSON.stringify({ type:'session', payload:{ state: currentQR?'qr':'connected', qrBase64: currentQR }}))
  })
})
