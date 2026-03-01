import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import LibraryPage from './pages/LibraryPage';
import ReaderPage from './pages/ReaderPage';

const router = createBrowserRouter([
  { path: '/', Component: LibraryPage },
  { path: '/read/:bookId', Component: ReaderPage },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
