import React from 'react';
import Console from './Console.jsx';
import Display from './Display.jsx';

export default function App() {
  if (window.location.pathname.startsWith('/console')) return <Console />;
  return <Display />;
}
