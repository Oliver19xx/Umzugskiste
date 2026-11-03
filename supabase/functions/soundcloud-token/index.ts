// @ts-nocheck: läuft in Deno auf Supabase Edge.
import { handle } from './handler.js';

Deno.serve(req => handle(req, Deno.env.toObject()));
