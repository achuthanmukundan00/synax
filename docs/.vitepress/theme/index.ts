import { h, type App } from 'vue';
import { useData } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import SynaxLanding from './components/SynaxLanding.vue';
import CoreTranscriptHero from './components/CoreTranscriptHero.vue';
import MeasuredTerminalBlock from './components/MeasuredTerminalBlock.vue';
import './style.css';

export default {
  extends: DefaultTheme,
  Layout() {
    const { frontmatter } = useData();
    if (frontmatter.value.layout === 'synax-landing') {
      return h(SynaxLanding);
    }
    return h(DefaultTheme.Layout);
  },
  enhanceApp({ app }: { app: App }) {
    app.component('SynaxLanding', SynaxLanding);
    app.component('CoreTranscriptHero', CoreTranscriptHero);
    app.component('MeasuredTerminalBlock', MeasuredTerminalBlock);
  },
};
