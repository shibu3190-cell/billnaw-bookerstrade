if (process.env.APP_TEST_MODE && process.env.APP_TEST_MODE !== 'isolated') {
  throw new Error('Refusing to start isolated mode with a conflicting APP_TEST_MODE value.');
}

process.env.APP_TEST_MODE = 'isolated';
process.env.PORT = '5001';
const app = require('./server');
app.listen(5001, '127.0.0.1', () => {
  console.log('Isolated test backend listening at http://127.0.0.1:5001');
});