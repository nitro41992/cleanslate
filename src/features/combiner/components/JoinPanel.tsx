import { Link2, Play, Loader2, Sparkles } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { ValidationWarnings } from './ValidationWarnings'
import { useTableStore } from '@/stores/tableStore'
import { useCombinerStore } from '@/stores/combinerStore'
import { validateJoin, joinTables, autoCleanKeys } from '@/lib/combiner-engine'
import { getTableColumns } from '@/lib/duckdb'
import { toast } from '@/hooks/use-toast'
import type { JoinType } from '@/types'

export function JoinPanel() {
  const tables = useTableStore((s) => s.tables)
  const addTable = useTableStore((s) => s.addTable)

  const {
    leftTableId,
    rightTableId,
    keyColumn,
    joinType,
    joinValidation,
    resultTableName,
    isProcessing,
    setLeftTableId,
    setRightTableId,
    setKeyColumn,
    setJoinType,
    setJoinValidation,
    setResultTableName,
    setIsProcessing,
    setError,
  } = useCombinerStore()

  const leftTable = tables.find((t) => t.id === leftTableId)
  const rightTable = tables.find((t) => t.id === rightTableId)

  // Get common columns between left and right tables
  const commonColumns =
    leftTable && rightTable
      ? leftTable.columns
          .map((c) => c.name)
          .filter((c) => rightTable.columns.some((rc) => rc.name === c))
      : []

  const handleValidate = async () => {
    if (!leftTable || !rightTable || !keyColumn) return

    try {
      const validation = await validateJoin(
        leftTable.name,
        rightTable.name,
        keyColumn
      )
      setJoinValidation(validation)
    } catch (error) {
      console.error('Validation failed:', error)
    }
  }

  const handleAutoClean = async () => {
    if (!leftTable || !rightTable || !keyColumn) return

    setIsProcessing(true)
    try {
      const { cleanedA, cleanedB } = await autoCleanKeys(
        leftTable.name,
        rightTable.name,
        keyColumn
      )

      toast({
        title: 'Keys Cleaned',
        description: `Trimmed whitespace from ${cleanedA} rows in ${leftTable.name} and ${cleanedB} rows in ${rightTable.name}`,
      })

      // Re-validate after cleaning
      await handleValidate()
    } catch (error) {
      console.error('Auto-clean failed:', error)
      toast({
        title: 'Auto-Clean Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const handleJoin = async () => {
    if (!leftTable || !rightTable || !keyColumn || !resultTableName.trim()) return

    setIsProcessing(true)
    try {
      const { rowCount } = await joinTables(
        leftTable.name,
        rightTable.name,
        keyColumn,
        joinType,
        resultTableName.trim()
      )

      // Get columns for the new table
      const columns = await getTableColumns(resultTableName.trim())

      // Add to table store
      addTable(
        resultTableName.trim(),
        columns.map((c) => ({ ...c, nullable: true })),
        rowCount
      )

      const joinTypeLabel =
        joinType === 'inner'
          ? 'Inner'
          : joinType === 'left'
          ? 'Left'
          : 'Full Outer'

      toast({
        title: 'Tables Joined',
        description: `Created "${resultTableName}" with ${rowCount} rows (${joinTypeLabel} Join)`,
      })

      // Reset form
      setResultTableName('')
      setJoinValidation(null)
    } catch (error) {
      console.error('Join failed:', error)
      setError(error instanceof Error ? error.message : 'Join operation failed')
      toast({
        title: 'Join Failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      })
    } finally {
      setIsProcessing(false)
    }
  }

  const hasWhitespaceWarning = joinValidation?.warnings.some((w) =>
    w.includes('whitespace')
  )

  return (
    <Card className="flex-1 flex flex-col">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Link2 className="w-4 h-4" />
          Join Tables
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col space-y-4">
        <p className="text-sm text-muted-foreground">
          Combine tables horizontally by matching rows on a key column. Similar
          to SQL JOIN operations.
        </p>

        {/* Left Table Selection */}
        <div className="space-y-2">
          <Label>Left Table</Label>
          <Select
            value={leftTableId || ''}
            onValueChange={(v) => {
              setLeftTableId(v)
              setKeyColumn(null)
              setJoinValidation(null)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select left table" />
            </SelectTrigger>
            <SelectContent>
              {tables.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} ({t.rowCount} rows)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Right Table Selection */}
        <div className="space-y-2">
          <Label>Right Table</Label>
          <Select
            value={rightTableId || ''}
            onValueChange={(v) => {
              setRightTableId(v)
              setKeyColumn(null)
              setJoinValidation(null)
            }}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select right table" />
            </SelectTrigger>
            <SelectContent>
              {tables
                .filter((t) => t.id !== leftTableId)
                .map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name} ({t.rowCount} rows)
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        {/* Key Column Selection */}
        {commonColumns.length > 0 && (
          <div className="space-y-2">
            <Label>Key Column</Label>
            <Select
              value={keyColumn || ''}
              onValueChange={(v) => {
                setKeyColumn(v)
                setJoinValidation(null)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select key column" />
              </SelectTrigger>
              <SelectContent>
                {commonColumns.map((col) => (
                  <SelectItem key={col} value={col}>
                    {col}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Join Type Selection */}
        {keyColumn && (
          <div className="space-y-2">
            <Label>Join Type</Label>
            <RadioGroup
              value={joinType}
              onValueChange={(v: string) => setJoinType(v as JoinType)}
              className="grid grid-cols-3 gap-2"
            >
              <div className="flex items-center space-x-2 p-2 border rounded-lg">
                <RadioGroupItem value="inner" id="inner" />
                <Label htmlFor="inner" className="cursor-pointer text-sm">
                  Inner
                </Label>
              </div>
              <div className="flex items-center space-x-2 p-2 border rounded-lg">
                <RadioGroupItem value="left" id="left" />
                <Label htmlFor="left" className="cursor-pointer text-sm">
                  Left
                </Label>
              </div>
              <div className="flex items-center space-x-2 p-2 border rounded-lg">
                <RadioGroupItem value="full_outer" id="full_outer" />
                <Label htmlFor="full_outer" className="cursor-pointer text-sm">
                  Full Outer
                </Label>
              </div>
            </RadioGroup>
          </div>
        )}

        {/* Validate Button */}
        {keyColumn && !joinValidation && (
          <Button variant="outline" onClick={handleValidate}>
            Validate Join
          </Button>
        )}

        {/* Validation Results */}
        {joinValidation && (
          <>
            <ValidationWarnings warnings={joinValidation.warnings} />
            {hasWhitespaceWarning && (
              <Button
                variant="outline"
                onClick={handleAutoClean}
                disabled={isProcessing}
                className="w-full"
              >
                <Sparkles className="w-4 h-4 mr-2" />
                Auto-Clean Keys
              </Button>
            )}
          </>
        )}

        {/* Result Table Name */}
        {keyColumn && (
          <div className="space-y-2">
            <Label htmlFor="join-result-name">Result Table Name</Label>
            <Input
              id="join-result-name"
              value={resultTableName}
              onChange={(e) => setResultTableName(e.target.value)}
              placeholder="e.g., orders_with_customers"
            />
          </div>
        )}

        {/* Join Button */}
        <div className="pt-4 mt-auto">
          <Button
            className="w-full"
            onClick={handleJoin}
            disabled={
              !leftTableId ||
              !rightTableId ||
              !keyColumn ||
              !resultTableName.trim() ||
              isProcessing
            }
            data-testid="combiner-join-btn"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Joining...
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Join Tables
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
