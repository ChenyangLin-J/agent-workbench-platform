import React from 'react';
import MarkdownBody from './markdown-body.jsx';
const MathRenderer = React.lazy(() => import('./markdown-math.jsx'));
export default function LazyMarkdownRenderer(props) {
  return <MarkdownBody {...props} mathRenderer={MathRenderer} />;
}
