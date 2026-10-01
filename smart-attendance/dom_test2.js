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
win.navigator.mediaDevices = { getUserMedia: () => Promise.reject(new Error()) };
win.navigator.geolocation = { getCurrentPosition: (ok, err) => err({ code: 1 }) };
win.fetch = () => Promise.reject(new Error());

setTimeout(() => {
  const doc = win.document;
  const body = doc.body;
  const cs = win.getComputedStyle(body);
  console.log('LIGHT MODE body background-color:', cs.backgroundColor);
  console.log('LIGHT MODE body color:', cs.color);

  doc.documentElement.setAttribute('data-theme', 'dark');
  const cs2 = win.getComputedStyle(body);
  console.log('DARK MODE body background-color:', cs2.backgroundColor);
  console.log('DARK MODE body color:', cs2.color);

  const loginBtn = doc.getElementById('login-btn');
  const btnStyle = win.getComputedStyle(loginBtn);
  console.log('login btn background (dark mode, should stay navy chrome):', btnStyle.backgroundColor);

  process.exit(0);
}, 800);
