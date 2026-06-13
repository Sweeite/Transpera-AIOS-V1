import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatView } from '@/features/chat/ChatView';

const queryClient = new QueryClient();

/**
 * App shell. For now it renders the M0 chat slice. As the product grows (issue #38), add a router and the
 * full nav: Ask → Knowledge → Work → Agents → Automate → Observe → Admin (Brief §13).
 */
export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ChatView />
    </QueryClientProvider>
  );
}
