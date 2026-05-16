import { createApp } from './server.js'

const host = process.env.XOX_API_HOST ?? '127.0.0.1'
const port = Number(process.env.XOX_API_PORT ?? process.env.PORT ?? 8000)

const app = await createApp()

await app.listen({ host, port })
