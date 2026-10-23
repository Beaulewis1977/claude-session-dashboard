// Runs first in the phone app: the components reach the PC through
// window.csd, which here is the HTTPS/WebSocket transport instead of IPC.

import { webApi } from '@/lib/web-api'

window.csd = webApi
