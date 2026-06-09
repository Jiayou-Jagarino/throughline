#!/usr/bin/env node
// Helper for context file tests — writes context.txt via the same code path used by markers
import { SessionStore } from '../dist/engine/SessionStore.js'
import { ContextBuilder } from '../dist/engine/ContextBuilder.js'

const cwd = process.argv[2]
const trigger = process.argv[3] || 'test'
const store = new SessionStore(cwd)
const cb = new ContextBuilder(store)
cb.writeContextFile(trigger)
process.stdout.write('ok')
