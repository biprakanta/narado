module.exports = (api) => ({
  presets: [
    // Under Jest, compile for the Node running the tests: newer syntax some dependencies ship
    // (query-string's regex `v` flag) runs as is rather than through Babel's rewrites.
    ['@babel/preset-env', api.env('test') ? { targets: { node: 'current' } } : {}],
    ['@babel/preset-react', {
      runtime: 'automatic'
    }]
  ],
  plugins: ['babel-plugin-styled-components']
});
