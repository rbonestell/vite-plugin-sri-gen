---
layout: home

hero:
  name: vite-plugin-sri-gen
  text: Autogenerate SRI hashes at build time
  tagline: Autogenerate Subresource Integrity hashes for every script, stylesheet, and module chunk your Vite build emits.
  image:
    src: /logo.png
    alt: vite-plugin-sri-gen logo
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: What is SRI?
      link: /learn/what-is-sri
    - theme: alt
      text: GitHub
      link: https://github.com/rbonestell/vite-plugin-sri-gen

features:
  - icon: 🛡️
    title: Stronger Security
    details: Browsers verify every asset against its build-time hash — a tampered CDN or compromised chunk fails closed instead of executing.
  - icon: ⚡
    title: Build-time Automation
    details: Hooks Vite and Rollup during build. No manual hashing, no postprocessing scripts, no server changes required.
  - icon: 🎛️
    title: Simple Config
    details: Drop sri() into your plugins array and ship. Sensible defaults cover SPA, MPA, and prerendered SSG output.
---
