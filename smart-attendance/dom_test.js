const { JSDOM } = require('jsdom');
const fs = require('fs');

let html = fs.readFileSync('client/index.html', 'utf8');
html = html.replace(/<link rel="preconnect"[^>]*>/, '');
html = html.replace(/<link href="https:\/\/fonts\.googleapis[^>]*>/, '');
html = html.replace(/<script src="https:\/\/cdnjs[^>]*><\/script>/g, '');
html = html.replace(/<script src="https:\/\/cdn\.jsdelivr[^>]*><\/script>/g, '');
const appjs = fs.readFileSync('client/app.js', 'utf8');
html = html.replace('<script src="app.js"></script>', `<script>${appjs}</script>`);

const dom = new JSDOM(html, { url: 'http://localhost:3000/', runScripts: 'dangerously', pretendToBeVisual: true });
const win = dom.window;
win.navigator.mediaDevices = { getUserMedia: () => Promise.reject(new Error('no camera in test')) };
win.navigator.geolocation = { getCurrentPosition: (ok, err) => err({ code: 1 }) };
win.fetch = () => Promise.reject(new Error('no network in test'));

let caught = [];
win.onerror = (msg, src, line, col, err) => { caught.push(`${msg} @ ${line}:${col}`); };
process.on('unhandledRejection', (e) => { caught.push('unhandledRejection: ' + e); });

setTimeout(() => {
  const doc = win.document;
  console.log('--- Errors ---'); console.log(caught.length ? caught.join('\n') : '(none)');
  console.log('--- Theme check ---');
  console.log('html data-theme:', doc.documentElement.getAttribute('data-theme'));
  console.log('login-theme-btn text:', doc.getElementById('login-theme-btn').textContent);
  console.log('app-theme-btn text:', doc.getElementById('app-theme-btn').textContent);
  // simulate click to toggle
  doc.getElementById('login-theme-btn').click();
  console.log('after click, data-theme:', doc.documentElement.getAttribute('data-theme'));
  console.log('after click, icon:', doc.getElementById('login-theme-btn').textContent);
  console.log('--- Role pills ---');
  console.log('role-pills children:', doc.getElementById('role-pills').children.length);
  console.log('DONE');
  process.exit(0);
}, 800);
