import { Merge } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StackPanel } from './components/StackPanel'
import { JoinPanel } from './components/JoinPanel'
import { useCombinerStore } from '@/stores/combinerStore'
import { useTableStore } from '@/stores/tableStore'

export function CombinerPage() {
  const tables = useTableStore((s) => s.tables)
  const { mode, setMode, setError } = useCombinerStore()

  const handleTabChange = (value: string) => {
    setMode(value as 'stack' | 'join')
    setError(null) // Clear any errors when switching tabs
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="h-14 flex items-center justify-between px-6 border-b border-border/50 bg-card/30">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Merge className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h1 className="font-semibold">Combiner</h1>
            <p className="text-xs text-muted-foreground">
              Stack or join tables together
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex min-h-0 p-4 gap-4">
        {tables.length < 2 ? (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="text-center">
              <Merge className="w-12 h-12 mx-auto mb-4 opacity-50" />
              <p className="text-lg font-medium mb-2">
                Load at least 2 tables to combine
              </p>
              <p className="text-sm">
                Go to the Laundromat to import tables first
              </p>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-w-0">
            <Tabs
              value={mode}
              onValueChange={handleTabChange}
              className="flex-1 flex flex-col"
            >
              <TabsList className="w-fit">
                <TabsTrigger value="stack" data-testid="combiner-stack-tab">
                  Stack (UNION)
                </TabsTrigger>
                <TabsTrigger value="join" data-testid="combiner-join-tab">
                  Join
                </TabsTrigger>
              </TabsList>

              <div className="flex-1 mt-4">
                <TabsContent value="stack" className="h-full mt-0">
                  <StackPanel />
                </TabsContent>
                <TabsContent value="join" className="h-full mt-0">
                  <JoinPanel />
                </TabsContent>
              </div>
            </Tabs>
          </div>
        )}
      </div>
    </div>
  )
}
