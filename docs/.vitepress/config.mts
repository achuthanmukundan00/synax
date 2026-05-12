import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Synax',
  description:
    'Local-first CLI coding agent with multi-provider routing and native tool-call parsers for 26 model families',
  base: '/',
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Architecture', link: '/guide/architecture' },
      { text: 'Extensions', link: '/guide/extensions' },
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
          { text: 'Providers', link: '/guide/providers' },
          { text: 'MCP', link: '/guide/mcp' },
          { text: 'Skills', link: '/guide/skills' },
          { text: 'Settings Menu', link: '/guide/settings-menu' },
          { text: 'Sessions', link: '/guide/sessions' },
          { text: 'Commands', link: '/guide/commands' },
          { text: 'Agent Loop and Tools', link: '/guide/agent-loop' },
          { text: 'Tool-Call Parsing', link: '/guide/tool-call-parsing' },
          { text: 'Safety and Context', link: '/guide/safety-context' },
          { text: 'Compatibility Reports', link: '/guide/compatibility' },
          { text: 'Development', link: '/guide/development' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'Extensions', link: '/guide/extensions' },
          { text: 'Runtime Architecture', link: '/architecture/runtime' },
        ],
      },
    ],
    search: {
      provider: 'local',
    },
    socialLinks: [{ icon: 'github', link: 'https://github.com/achuthanmukundan00/synax' }],
  },
});
