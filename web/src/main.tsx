import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { App } from './components/App';
import { init } from './store';

createRoot(document.getElementById('root')!).render(<App />);
void init();
