// Use Node to set the environment so npm start also works on Windows.
process.env.NODE_ENV = 'production';
const { start } = await import('../server.js');
await start();
