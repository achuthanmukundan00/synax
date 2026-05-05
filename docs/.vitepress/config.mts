import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Synax',
  description: 'Local-first CLI coding agent for Relay-compatible local inference',
  base: '/',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Relay', link: '/guide/relay' },
      { text: 'Commands', link: '/guide/commands' },
      { text: 'Compatibility', link: '/guide/compatibility' },
      { text: 'GitHub', link: 'https://github.com/achuthanmukundan00/synax' },
    ],
    sidebar: [
      {
        text: 'Synax',
        items: [
          { text: 'Overview', link: '/' },
          { text: 'Getting Started', link: '/guide/getting-started' },
          { text: 'Relay Setup', link: '/guide/relay' },
          { text: 'Configuration', link: '/guide/configuration' },
          { text: 'Commands', link: '/guide/commands' },
          { text: 'Agent Loop and Tools', link: '/guide/agent-loop' },
          { text: 'Safety and Context', link: '/guide/safety-context' },
          { text: 'Compatibility Reports', link: '/guide/compatibility' },
          { text: 'Development', link: '/guide/development' },
        ],
      },
    ],
    search: {
      provider: 'local',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/achuthanmukundan00/synax' }],
  },
});
