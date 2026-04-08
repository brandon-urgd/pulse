import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { configureAmplify } from './config/amplify';
import { ProtectedRoute } from './components/ProtectedRoute';
import AdminLayout from './layouts/AdminLayout';
import SplashEntry from './pages/SplashEntry';
import Welcome from './pages/Welcome';
import Items from './pages/Items';
import ItemDetail from './pages/ItemDetail';
import ItemNewPage from './pages/ItemNewPage';
import ItemEditPage from './pages/ItemEditPage';
import ItemRevision from './pages/ItemRevision';
import SessionReport from './pages/SessionReport';
import PulseCheck from './pages/PulseCheck';
import PulseCheckIndex from './pages/PulseCheckIndex';
import Settings from './pages/Settings';
import Plan from './pages/Plan';
import ForgotPassword from './pages/ForgotPassword';

configureAmplify();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Entry point — splash, login, register all in one */}
          <Route path="/" element={<SplashEntry />} />
          <Route path="/admin/login" element={<Navigate to="/" replace />} />
          <Route path="/admin/register" element={<Navigate to="/" replace />} />
          <Route path="/admin/forgot-password" element={<ForgotPassword />} />

          {/* Protected — standalone (no layout shell) */}
          <Route
            path="/admin/welcome"
            element={
              <ProtectedRoute>
                <Welcome />
              </ProtectedRoute>
            }
          />

          {/* Protected — inside AdminLayout */}
          <Route
            path="/admin"
            element={
              <ProtectedRoute>
                <AdminLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<Navigate to="/admin/items" replace />} />
            <Route path="items" element={<Items />} />
            <Route path="items/new" element={<ItemNewPage />} />
            <Route path="items/:itemId/edit" element={<ItemEditPage />} />
            <Route path="items/:itemId" element={<ItemDetail />} />
            <Route path="items/:itemId/revisions" element={<ItemRevision />} />
            <Route path="items/:itemId/sessions/:sessionId/report" element={<SessionReport />} />
            <Route path="pulse-check" element={<PulseCheckIndex />} />
            <Route path="pulse-check/:itemId" element={<PulseCheck />} />
            <Route path="plan" element={<Plan />} />
            <Route path="settings" element={<Settings />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
