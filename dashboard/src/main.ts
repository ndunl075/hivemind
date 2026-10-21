import './styles.css';
import { mountApp } from './app';
import { createSource, sourceNeedsToken } from './live';
import { resolveToken, roomFromPath } from './token';

const root = document.getElementById('app');
if (root) {
  const token = resolveToken(location, (url) => history.replaceState(null, '', url));
  const demo = new URLSearchParams(location.search).get('demo');
  mountApp(root, { createSource, sourceNeedsToken, room: roomFromPath(location.pathname), token, demo });
}
