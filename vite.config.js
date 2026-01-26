import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { consoleForwardPlugin } from 'vite-console-forward-plugin';
export default defineConfig({
    plugins: [
        react(),
        consoleForwardPlugin(),
    ],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    optimizeDeps: {
        exclude: ['@duckdb/duckdb-wasm'],
    },
    worker: {
        format: 'es',
    },
});
