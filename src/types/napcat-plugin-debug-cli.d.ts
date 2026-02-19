declare module 'napcat-plugin-debug-cli/vite' {
    import type { Plugin } from 'vite';

    interface NapcatHmrPluginOptions {
        wsUrl?: string;
    }

    function napcatHmrPlugin(options?: NapcatHmrPluginOptions): Plugin;
    export { napcatHmrPlugin };
}
