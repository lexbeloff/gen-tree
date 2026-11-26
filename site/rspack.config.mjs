import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@rspack/cli';
import { rspack } from '@rspack/core';
import { buildData, outDirFor, resolveDataDir } from './scripts/build-data.ts';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = resolveDataDir();
const outDir = outDirFor(dataDir);
const isProd = process.env.NODE_ENV === 'production';

/** Собирает tree.json перед каждой (пере)сборкой; следит за папкой данных. */
class DataPlugin {
  apply(compiler) {
    let lastError = null;
    const run = () => {
      try {
        const res = buildData(dataDir);
        for (const w of res.warnings) console.warn(`[data] предупреждение: ${w}`);
        if (res.changed) console.log(`[data] обновлено (персон: ${res.persons})`);
        lastError = null;
      } catch (e) {
        lastError = e;
      }
    };
    compiler.hooks.beforeRun.tap('DataPlugin', run);
    compiler.hooks.watchRun.tap('DataPlugin', run);
    compiler.hooks.thisCompilation.tap('DataPlugin', (compilation) => {
      compilation.contextDependencies.add(dataDir);
      if (lastError) compilation.errors.push(new rspack.WebpackError(`[data] ${lastError.message}`));
    });
  }
}

export default defineConfig({
  context: root,
  entry: { main: './src/main.ts' },
  mode: isProd ? 'production' : 'development',
  devtool: isProd ? false : 'eval-cheap-module-source-map',
  output: {
    path: path.join(root, 'dist'),
    filename: isProd ? '[name].[contenthash:8].js' : '[name].js',
    publicPath: 'auto',
    clean: true,
  },
  resolve: { extensions: ['.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        loader: 'builtin:swc-loader',
        options: { jsc: { parser: { syntax: 'typescript' }, target: 'es2022' } },
        type: 'javascript/auto',
      },
      {
        test: /\.scss$/,
        use: [{ loader: 'sass-loader', options: { api: 'modern-compiler' } }],
        type: 'css/auto',
      },
    ],
  },
  experiments: { css: true },
  plugins: [
    new DataPlugin(),
    new rspack.HtmlRspackPlugin({ template: './src/index.html', scriptLoading: 'defer' }),
    new rspack.CopyRspackPlugin({ patterns: [{ from: outDir, to: 'data', noErrorOnMissing: true }] }),
  ],
  devServer: {
    host: '127.0.0.1',
    port: Number(process.env.PORT ?? 5173),
    hot: false,
    liveReload: true,
    open: false,
    allowedHosts: 'all',
    watchFiles: { paths: [outDir] },
    static: false,
  },
  performance: { hints: false },
  stats: 'errors-warnings',
});
