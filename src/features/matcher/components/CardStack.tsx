import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Check, X, ArrowLeftRight } from 'lucide-react'
import type { MatchPair } from '@/types'
import { cn } from '@/lib/utils'

interface CardStackProps {
  pair: MatchPair
  onMerge: () => void
  onKeepSeparate: () => void
  matchColumn: string
}

export function CardStack({ pair, onMerge, onKeepSeparate, matchColumn }: CardStackProps) {
  const [direction, setDirection] = useState<'left' | 'right' | null>(null)

  const handleMerge = () => {
    setDirection('right')
    setTimeout(() => {
      onMerge()
      setDirection(null)
    }, 300)
  }

  const handleKeepSeparate = () => {
    setDirection('left')
    setTimeout(() => {
      onKeepSeparate()
      setDirection(null)
    }, 300)
  }

  const columns = Object.keys(pair.rowA)

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-3xl px-4">
      <AnimatePresence mode="wait">
        <motion.div
          key={pair.id}
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{
            scale: 1,
            opacity: 1,
            y: 0,
            x: direction === 'left' ? -300 : direction === 'right' ? 300 : 0,
            rotate: direction === 'left' ? -15 : direction === 'right' ? 15 : 0,
          }}
          exit={{ scale: 0.9, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'easeOut' }}
          className="w-full"
        >
          <Card className="overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-border/50 bg-muted/30">
              <div className="flex items-center gap-2">
                <Badge variant="secondary">
                  Score: {pair.score}
                </Badge>
                <span className="text-sm text-muted-foreground">
                  (lower = more similar)
                </span>
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-red-400">Record A</span>
                <ArrowLeftRight className="w-4 h-4 text-muted-foreground" />
                <span className="text-green-400">Record B</span>
              </div>
            </div>

            {/* Comparison Table */}
            <ScrollArea className="h-[300px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border/50">
                    <th className="text-left p-3 font-medium text-muted-foreground w-1/4">
                      Column
                    </th>
                    <th className="text-left p-3 font-medium text-red-400/80 w-[37.5%]">
                      Record A
                    </th>
                    <th className="text-left p-3 font-medium text-green-400/80 w-[37.5%]">
                      Record B
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((col) => {
                    const valA = pair.rowA[col]
                    const valB = pair.rowB[col]
                    const strA = valA === null || valA === undefined ? '' : String(valA)
                    const strB = valB === null || valB === undefined ? '' : String(valB)
                    const isDifferent = strA !== strB
                    const isMatchColumn = col === matchColumn

                    return (
                      <tr
                        key={col}
                        className={cn(
                          'border-b border-border/30',
                          isMatchColumn && 'bg-primary/5',
                          isDifferent && !isMatchColumn && 'bg-yellow-500/5'
                        )}
                      >
                        <td className="p-3 font-medium">
                          {col}
                          {isMatchColumn && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              match key
                            </Badge>
                          )}
                        </td>
                        <td
                          className={cn(
                            'p-3',
                            isDifferent && 'text-red-400'
                          )}
                        >
                          {strA || <span className="text-muted-foreground italic">empty</span>}
                        </td>
                        <td
                          className={cn(
                            'p-3',
                            isDifferent && 'text-green-400'
                          )}
                        >
                          {strB || <span className="text-muted-foreground italic">empty</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </ScrollArea>
          </Card>
        </motion.div>
      </AnimatePresence>

      {/* Action Buttons */}
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="lg"
          onClick={handleKeepSeparate}
          className="gap-2 px-8"
        >
          <X className="w-5 h-5" />
          Keep Separate
        </Button>
        <Button
          size="lg"
          onClick={handleMerge}
          className="gap-2 px-8"
        >
          <Check className="w-5 h-5" />
          Merge (Keep A)
        </Button>
      </div>
    </div>
  )
}
