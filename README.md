# Pattern-16

A web-based 16-step groovebox for making beats and music in the browser. Built around the Web Audio API with React for the UI.

## What it is

Pattern-16 is a tactile, opinionated drum machine and beat-making tool. It runs entirely in the browser — no install, no account, no server. You write patterns by clicking cells on a 16-step grid, layer pitched melodies and chord progressions, and end up with a finished beat you can export as WAV or share as a link.

The aesthetic is hardware-instrument: dark UI, amber accent, designed to feel like a piece of gear rather than a web form.

## Features

**Sequencing**
- 16-step sequencer across 8 assignable slots
- Per-step velocity (soft / medium / loud) and probability (100% / 75% / 50% / 25%)
- Swing from 0 to 0.66 — straight, subtle, or full shuffle
- 4 pattern banks (A/B/C/D) chainable into an 8-bar arrangement

**Sounds**
- 25+ synthesized voices across drums, cymbals, percussion, bass, and tonal categories
- Sample upload per slot (drag any WAV/MP3 onto a row)
- 9 curated kits (Boom-Bap, Trap, House, Drill, Lo-Fi, Acid House, Jungle/DnB, Afrobeats, Ambient)

**Pitched and melodic**
- Pitched rows for 808, sub bass, synth bass, acid bass, reese bass, pluck, chord stab, and pad
- Melody mode: expanded piano-roll editor on any pitched slot with multi-step note sustain
- Chord progressions across banks — each bank has its own chord; chord-stab plays it automatically
- Follow-chord transposition: write a bassline in one key, it adapts to each bank's chord

**Mix**
- Master GLUE chain (compressor → saturator → limiter) in one knob
- Per-slot drive (saturation)
- Sidechain compressor ducks selected slots on every kick
- Two global sends: reverb (convolution) and tempo-synced delay
- AUTO MIX button applies sensible defaults to whatever you've made

**Workflow**
- WAV export of the full chain with all mix processing applied
- JSON import/export of patterns
- Share patterns as URLs — pattern is encoded in the URL hash, no server needed
- AI helper button copies a system prompt to clipboard; paste into Claude or ChatGPT, describe a vibe, get a JSON pattern back
