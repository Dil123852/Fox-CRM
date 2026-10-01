import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';
import { installBusinessTimeZone } from './lib/businessTime';

// Before the first render: every date/time shown is Sri Lanka time, whatever
// the viewer's computer is set to (see lib/businessTime.js).
installBusinessTimeZone();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
