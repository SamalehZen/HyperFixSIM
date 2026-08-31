import {
  buildChart,
  bucketPieData,
  labelize,
  resolveDataKey,
  resolvePieTooltipLabel,
  sortByDateKey,
  toKey,
} from '@/lib/nao-charts'
import { displayChart, DEFAULT_DATE_FORMAT_SETTINGS } from '@/lib/nao-charts'
import { useChartWidth } from './use-chart-theme'
import { cn } from '@sim/emcn'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type React from 'react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Customized } from 'recharts'

import { Button } from '../ui/button'
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '../ui/chart'
import type { ChartConfig } from '../ui/chart'

const Colors = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
]
const LEGEND_SCROLL_OFFSET = 120
const PIE_LEGEND_BREAKPOINT = 280
const HORIZONTAL_LABEL_GAP = 12
const DIAGONAL_LABEL_GAP = 8
const CHAR_WIDTH_RATIO = 0.6
const ANGLE_COS = Math.cos((35 * Math.PI) / 180)
const ANGLE_SIN = Math.sin((35 * Math.PI) / 180)
const MIN_TICK_FONT = 9
const MAX_TICK_FONT = 12
const MAX_TICK_LABEL_HEIGHT = 44
type ViewMode = 'chart' | 'data' | 'query'

/** Vue simplifiée pour sim: reçoit la config display_chart + les rows execute_sql directement. */
export interface DisplayChartViewProps {
  config: displayChart.ChartInput | displayChart.KpiCardInput
  data: Record<string, unknown>[]
  columns?: string[]
  titleOverride?: string
}

export const DisplayChartView = memo(function DisplayChartView({
  config,
  data,
  columns: _columns,
  titleOverride,
}: DisplayChartViewProps) {
  const chartConfig = displayChart.isChartInput(config) ? config : undefined
  const tableConfig = displayChart.isTableInput(config) ? config : undefined
  const isTableVariant = config.chart_type === 'table'
  const isBuiltinChart = chartConfig
    ? displayChart.isBuiltinChartType(chartConfig.chart_type)
    : false

  const filteredData = useMemo(() => {
    if (!data || !chartConfig) return []
    if (chartConfig.x_axis_type !== 'date') return data
    const xAxisKey = resolveDataKey(data, chartConfig.x_axis_key)
    return sortByDateKey(data, xAxisKey)
  }, [data, chartConfig])

  if (isTableVariant) {
    return (
      <div className='my-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b border-[var(--border)]'>
              {(tableConfig ? Object.keys(data[0] ?? {}) : []).map((c) => (
                <th key={c} className='px-3 py-2 text-left text-[var(--text-muted)] font-medium'>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.slice(0, 50).map((row, i) => (
              <tr key={i} className='border-b border-[var(--border)] last:border-b-0'>
                {Object.values(row).map((v, j) => (
                  <td key={j} className='px-3 py-2 text-[var(--text-body)]'>
                    {String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  if (!chartConfig || !isBuiltinChart) {
    if (!chartConfig) return null
    return (
      <div className='my-2 text-[var(--text-muted)] text-sm'>
        Ce type de graphique personnalisé n&apos;est pas pris en charge dans cette vue.
      </div>
    )
  }

  if (chartConfig.series.length === 0) {
    return (
      <div className='my-2 text-[var(--text-muted)] text-sm'>
        Could not display the chart because no series are configured.
      </div>
    )
  }

  if (filteredData.length === 0) {
    return <div className='my-2 text-[var(--text-muted)] text-sm'>No data</div>
  }

  return (
    <ChartDisplay
      data={filteredData}
      chartType={chartConfig.chart_type as displayChart.ChartType}
      xAxisKey={chartConfig.x_axis_key ?? ''}
      series={chartConfig.series}
      xAxisType={chartConfig.x_axis_type === 'number' ? 'number' : 'category'}
      xAxisLabel={chartConfig.x_axis_label}
      title={titleOverride ?? chartConfig.title}
      yAxisMin={chartConfig.y_axis_min}
      yAxisMax={chartConfig.y_axis_max}
      yAxisLabel={chartConfig.y_axis_label}
      yAxisRightMin={chartConfig.y_axis_right_min}
      yAxisRightMax={chartConfig.y_axis_right_max}
      yAxisRightLabel={chartConfig.y_axis_right_label}
      showDataLabels={chartConfig.show_data_labels}
      comparisonMode={'comparison_mode' in chartConfig ? chartConfig.comparison_mode : undefined}
      hideTotal={chartConfig.hide_total}
    />
  )
})

export interface ChartDisplayProps {
  data: Record<string, unknown>[]
  chartType: displayChart.ChartType
  xAxisKey: string
  xAxisType: 'number' | 'category'
  xAxisLabel?: string
  xAxisLabelFormatter?: (value: string) => string
  valueFormatter?: (value: number) => string
  series: displayChart.SeriesConfig[]
  title?: string
  titleStyle?: 'default' | 'left'
  titleAccessory?: React.ReactNode
  showLegend?: boolean
  showGrid?: boolean
  yAxisMin?: number
  yAxisMax?: number
  yAxisLabel?: string
  yAxisRightMin?: number
  yAxisRightMax?: number
  yAxisRightLabel?: string
  showDataLabels?: boolean
  animate?: boolean
  comparisonMode?: displayChart.ComparisonMode
  className?: string
  chartContainerClassName?: string
  chartContentClassName?: string
  normalSize?: boolean
  hideTotal?: boolean
  kpiLeadingSlot?: React.ReactNode
  disableTooltip?: boolean
}

export const ChartDisplay = memo(function ChartDisplay({
  data,
  chartType,
  xAxisKey: xAxisKeyProp,
  xAxisType,
  xAxisLabel,
  xAxisLabelFormatter,
  valueFormatter,
  series: seriesProp,
  title,
  titleStyle = 'default',
  titleAccessory,
  showLegend = true,
  showGrid = true,
  yAxisMin,
  yAxisMax,
  yAxisLabel,
  yAxisRightMin,
  yAxisRightMax,
  yAxisRightLabel,
  showDataLabels,
  animate = false,
  comparisonMode,
  className,
  chartContainerClassName,
  chartContentClassName,
  normalSize = false,
  hideTotal,
  kpiLeadingSlot,
  disableTooltip = false,
}: ChartDisplayProps) {
  const dateFormat = useMemo(() => ({ ...DEFAULT_DATE_FORMAT_SETTINGS }), [])
  const [containerRef, measuredWidth] = useChartWidth()
  const width = measuredWidth ?? 0
  const [plotWidth, setPlotWidth] = useState(0)
  const gradientIdPrefix = `${useId().replace(/[^a-zA-Z0-9]/g, '')}-`
  const handlePlotWidthChange = useCallback((nextPlotWidth: number) => {
    setPlotWidth((currentPlotWidth) =>
      currentPlotWidth === nextPlotWidth ? currentPlotWidth : nextPlotWidth
    )
  }, [])

  const xAxisKey = useMemo(() => resolveDataKey(data, xAxisKeyProp), [data, xAxisKeyProp])
  const series = useMemo(
    () => seriesProp.map((s) => ({ ...s, data_key: resolveDataKey(data, s.data_key) })),
    [data, seriesProp]
  )

  const { visibleSeries, hiddenSeriesKeys, handleToggleSeriesVisibility } =
    useSeriesVisibility(series)
  const isPercentStacked = displayChart.isPercentStackedChartType(chartType)

  const isPie = displayChart.isPieChart(chartType)
  const compactPieLegend = isPie && width > 0 && width < PIE_LEGEND_BREAKPOINT
  const pieCenteringClass = isPie && !compactPieLegend ? 'mx-auto max-w-[480px]' : ''
  const pieValueKey = series[0]?.data_key ?? ''
  const pieData = useMemo(
    () => (isPie ? bucketPieData(data, xAxisKey, pieValueKey) : data),
    [isPie, data, xAxisKey, pieValueKey]
  )
  const useInlineHeader = titleStyle === 'left' && Boolean(title) && !isPie
  const showInlineLegend = showLegend && chartType !== 'kpi_card'
  const { scrollRef, canScrollLeft, canScrollRight, scrollLegend } = useHorizontalScrollControls()

  const chartConfig = useMemo((): ChartConfig => {
    if (isPie) {
      return pieData.reduce<ChartConfig>(
        (acc, item, index) => {
          const category = String(item[xAxisKey])
          acc[toKey(category)] = {
            label: labelize(category, dateFormat),
            color: Colors[index % Colors.length],
          }
          return acc
        },
        {
          [xAxisKey]: {
            label: labelize(xAxisKey, dateFormat),
          },
          [pieValueKey]: {
            valueFormat: series[0]?.value_format,
          },
        }
      )
    }

    return series.reduce((acc, s, idx) => {
      acc[s.data_key] = {
        label: s.label || labelize(s.data_key, dateFormat),
        color: s.color || Colors[idx % Colors.length],
        isTotal: s.is_total,
        valueFormat: s.value_format,
      }
      return acc
    }, {} as ChartConfig)
  }, [series, xAxisKey, pieValueKey, pieData, isPie, dateFormat])

  const colorFor = useMemo(
    () =>
      isPie
        ? (value: string, _i: number) => `var(--color-${toKey(value)})`
        : (dataKey: string, _i: number) => `var(--color-${dataKey})`,
    [isPie]
  )

  const legendPayload = useMemo(() => {
    if (isPie) {
      return pieData.map((item, index) => {
        const category = String(item[xAxisKey])
        return {
          value: category,
          dataKey: toKey(category),
          color: Colors[index % Colors.length],
          isHidden: false,
        }
      })
    }
    return series.map((s, idx) => ({
      value: s.label || labelize(s.data_key, dateFormat),
      dataKey: s.data_key,
      color: s.color || Colors[idx % Colors.length],
      isHidden: hiddenSeriesKeys.has(s.data_key),
    }))
  }, [isPie, pieData, xAxisKey, series, hiddenSeriesKeys, dateFormat])

  const labelFormatter = useMemo(
    () => xAxisLabelFormatter ?? ((value: string) => labelize(value, dateFormat)),
    [xAxisLabelFormatter, dateFormat]
  )
  const xAxisWidth = plotWidth > 0 ? plotWidth : width
  const perCategoryPx = xAxisWidth > 0 ? xAxisWidth / Math.max(data.length, 1) : 0
  const longestLabelLen = Math.max(
    1,
    ...data.map((row) => labelFormatter(String(row[xAxisKey])).length)
  )
  // Keep labels horizontal while they fit side by side (label width plus a small gap);
  // only once they would actually collide do we shrink + rotate, and then discard.
  const horizontalLabelPx =
    longestLabelLen * MAX_TICK_FONT * CHAR_WIDTH_RATIO + HORIZONTAL_LABEL_GAP
  const compactXAxis =
    !isPie && xAxisType === 'category' && xAxisWidth > 0 && perCategoryPx < horizontalLabelPx

  let xAxisTickFontSize: number | undefined
  let xAxisMaxLabelChars: number | undefined
  let compactXAxisInterval: number | undefined
  if (compactXAxis) {
    const neededFont = perCategoryPx / (longestLabelLen * CHAR_WIDTH_RATIO * ANGLE_COS)
    xAxisTickFontSize = Math.round(Math.max(MIN_TICK_FONT, Math.min(MAX_TICK_FONT, neededFont)))

    const charPx = xAxisTickFontSize * CHAR_WIDTH_RATIO
    // A rotated label can't be taller than the axis band, so cap its length first, then
    // reserve slots from the length we actually draw (not the full label) — otherwise we
    // discard more labels than the space truly needs.
    const verticalCharCap = Math.floor(MAX_TICK_LABEL_HEIGHT / (charPx * ANGLE_SIN))
    if (longestLabelLen > verticalCharCap) {
      xAxisMaxLabelChars = verticalCharCap
    }
    const drawnLabelLen = Math.min(longestLabelLen, verticalCharCap)
    const labelSlotPx = drawnLabelLen * charPx * ANGLE_COS + DIAGONAL_LABEL_GAP
    if (perCategoryPx < labelSlotPx) {
      // N labels need only N-1 gaps between them, so credit one gap back before dividing;
      // otherwise a label is discarded a full slot early, before the labels actually touch.
      const maxVisible = Math.max(1, Math.floor((xAxisWidth + DIAGONAL_LABEL_GAP) / labelSlotPx))
      compactXAxisInterval = Math.max(0, Math.ceil(data.length / maxVisible) - 1)
    }
  }

  const tooltipLabelFormatter = useMemo(
    () => (value: unknown, items: unknown) =>
      isPie
        ? labelize(resolvePieTooltipLabel(items as { name?: unknown }[]), dateFormat)
        : labelize(value as string, dateFormat),
    [isPie, dateFormat]
  )

  const isDualAxis =
    displayChart.isComboChart(chartType) && displayChart.hasRightAxisSeries(visibleSeries)

  const chartElement = useMemo(
    () =>
      buildChart({
        data: pieData,
        chartType,
        xAxisKey,
        xAxisType,
        xAxisLabel,
        series: visibleSeries,
        colorFor,
        labelFormatter,
        valueFormatter,
        compactXAxis,
        compactXAxisInterval,
        xAxisTickFontSize,
        xAxisMaxLabelChars,
        showGrid,
        showDataLabels,
        animate,
        comparisonMode,
        gradientIdPrefix,
        kpiLeadingSlot,
        margin: { top: 0, right: 0, bottom: 0, left: 0 },
        yAxisMin,
        yAxisMax,
        yAxisLabel,
        yAxisRightMin,
        yAxisRightMax,
        yAxisRightLabel,
        children: [
          <ChartTooltip
            key='tooltip'
            active={disableTooltip ? false : undefined}
            animationDuration={150}
            animationEasing='linear'
            allowEscapeViewBox={{ y: true, x: false }}
            content={
              <ChartTooltipContent
                percent={isPercentStacked}
                isDualAxis={isDualAxis}
                hideTotal={hideTotal}
                labelFormatter={tooltipLabelFormatter}
                nameKey={isPie ? pieValueKey : undefined}
                valueFormatter={valueFormatter}
              />
            }
          />,
          chartType !== 'kpi_card' && (
            <Customized
              key='plot-width-observer'
              component={<ChartPlotWidthObserver onWidthChange={handlePlotWidthChange} />}
            />
          ),
          showLegend && chartType !== 'kpi_card' && !useInlineHeader && (
            <ChartLegend
              key='legend'
              payload={legendPayload}
              layout={isPie && !compactPieLegend ? 'vertical' : 'horizontal'}
              align={isPie && !compactPieLegend ? 'right' : 'center'}
              verticalAlign={isPie && !compactPieLegend ? 'middle' : 'bottom'}
              content={
                <ChartLegendContent
                  layout={isPie && !compactPieLegend ? 'vertical' : 'horizontal'}
                  className={compactPieLegend ? 'flex-wrap' : undefined}
                  onItemClick={isPie ? undefined : handleToggleSeriesVisibility}
                />
              }
            />
          ),
        ].filter(Boolean),
        title: useInlineHeader ? undefined : title,
        renderTitle: false,
      }),
    [
      pieData,
      chartType,
      isPie,
      compactPieLegend,
      compactXAxis,
      compactXAxisInterval,
      xAxisTickFontSize,
      xAxisMaxLabelChars,
      xAxisKey,
      pieValueKey,
      xAxisType,
      xAxisLabel,
      visibleSeries,
      colorFor,
      labelFormatter,
      tooltipLabelFormatter,
      valueFormatter,
      showGrid,
      yAxisMin,
      yAxisMax,
      yAxisLabel,
      yAxisRightMin,
      yAxisRightMax,
      yAxisRightLabel,
      isDualAxis,
      showDataLabels,
      animate,
      comparisonMode,
      gradientIdPrefix,
      kpiLeadingSlot,
      hideTotal,
      handlePlotWidthChange,
      legendPayload,
      handleToggleSeriesVisibility,
      title,
      isPercentStacked,
      showLegend,
      useInlineHeader,
      disableTooltip,
    ]
  )

  const inlineHeader = useInlineHeader ? (
    <div className='mb-6 flex w-full min-w-0 items-center gap-3'>
      <div className={showInlineLegend ? 'min-h-11 shrink-0' : 'shrink-0'}>
        <span className='block text-[15px] font-semibold'>{title}</span>
        {titleAccessory}
      </div>
      {showInlineLegend && canScrollLeft && (
        <Button
          variant='ghost'
          size='icon'
          onClick={() => scrollLegend('left')}
          aria-label='Scroll legend left'
          className='shrink-0'
        >
          <ChevronLeft className='size-3.5' />
        </Button>
      )}
      {showInlineLegend && (
        <div
          ref={scrollRef}
          className='min-w-0 flex-1 overflow-x-auto pl-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
        >
          <ChartLegendContent
            payload={legendPayload}
            align='right'
            onItemClick={handleToggleSeriesVisibility}
            className='w-max min-w-full gap-3 p-0 text-[10px] [&>*]:shrink-0'
          />
        </div>
      )}
      {showInlineLegend && canScrollRight && (
        <Button
          variant='ghost'
          size='icon'
          onClick={() => scrollLegend('right')}
          aria-label='Scroll legend right'
          className='shrink-0'
        >
          <ChevronRight className='size-3.5' />
        </Button>
      )}
    </div>
  ) : undefined

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex flex-col items-stretch gap-2 w-full',
        chartType !== 'kpi_card' && normalSize ? 'h-full' : '',
        className
      )}
    >
      {chartType === 'kpi_card' ? (
        <>
          {inlineHeader}
          {chartElement}
        </>
      ) : (
        <ChartContainer
          config={chartConfig}
          className={cn(
            normalSize ? 'h-full w-full' : 'w-full',
            pieCenteringClass,
            chartContainerClassName
          )}
          contentClassName={cn(
            normalSize ? 'aspect-auto flex-1 min-h-0' : undefined,
            chartContentClassName
          )}
          header={inlineHeader}
        >
          {chartElement}
        </ChartContainer>
      )}
    </div>
  )
})

interface ChartPlotWidthObserverProps {
  offset?: { width?: number }
  onWidthChange: (width: number) => void
}

function ChartPlotWidthObserver({ offset, onWidthChange }: ChartPlotWidthObserverProps) {
  const offsetWidth = offset?.width

  useEffect(() => {
    if (typeof offsetWidth === 'number' && Number.isFinite(offsetWidth) && offsetWidth > 0) {
      onWidthChange(offsetWidth)
    }
  }, [offsetWidth, onWidthChange])

  return null
}

const useHorizontalScrollControls = () => {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollState, setScrollState] = useState({
    canScrollLeft: false,
    canScrollRight: false,
  })

  const updateScrollState = useCallback(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }

    const maxScrollLeft = element.scrollWidth - element.clientWidth
    setScrollState({
      canScrollLeft: element.scrollLeft > 1,
      canScrollRight: element.scrollLeft < maxScrollLeft - 1,
    })
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) {
      return
    }

    updateScrollState()
    element.addEventListener('scroll', updateScrollState, { passive: true })

    if (typeof ResizeObserver === 'undefined') {
      return () => element.removeEventListener('scroll', updateScrollState)
    }

    const resizeObserver = new ResizeObserver(updateScrollState)
    resizeObserver.observe(element)

    if (element.firstElementChild) {
      resizeObserver.observe(element.firstElementChild)
    }

    return () => {
      element.removeEventListener('scroll', updateScrollState)
      resizeObserver.disconnect()
    }
  }, [updateScrollState])

  const scrollLegend = useCallback((direction: 'left' | 'right') => {
    scrollRef.current?.scrollBy({
      left: direction === 'left' ? -LEGEND_SCROLL_OFFSET : LEGEND_SCROLL_OFFSET,
      behavior: 'smooth',
    })
  }, [])

  return {
    ...scrollState,
    scrollRef,
    scrollLegend,
  }
}

/** Manages which series are visible and hidden */
const useSeriesVisibility = (series: displayChart.SeriesConfig[]) => {
  const [hiddenSeriesKeys, setHiddenSeriesKeys] = useState<Set<string>>(new Set())

  const visibleSeries = useMemo(
    () => series.filter((s) => !hiddenSeriesKeys.has(s.data_key)),
    [series, hiddenSeriesKeys]
  )

  const handleToggleSeriesVisibility = useCallback((dataKey: string) => {
    setHiddenSeriesKeys((prev) => {
      const copy = new Set(prev)
      if (copy.has(dataKey)) {
        copy.delete(dataKey)
      } else {
        copy.add(dataKey)
      }
      return copy
    })
  }, [])

  return {
    visibleSeries,
    hiddenSeriesKeys,
    handleToggleSeriesVisibility,
  }
}
