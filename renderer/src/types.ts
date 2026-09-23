export type DataSource = 'yahoo' | 'binance' | 'finra';

export type Candle = {
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
};

export type PlotPane = 'overlay' | 'oscillator';

export type PlotPoint = {
    title: string;
    time: number;
    value: number;
    options?: Record<string, unknown>;
};

export type PlotSeries = {
    id: string;
    title: string;
    color: string;
    style: string;
    pane: PlotPane;
    data: PlotPoint[];
};

export type LineDrawing = {
    id: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    xloc: string;
    extend: string;
    color: string;
    style: string;
    width: number;
    forceOverlay: boolean;
};

export type ShapeMarker = {
    id: string;
    title: string;
    time: number;
    color: string;
    text: string;
    shape: string;
    location: string;
    size: string;
    pane: PlotPane;
};

export type RunResponse = {
    source: DataSource;
    symbol: string;
    timeframe: string;
    limit: number;
    candles: Candle[];
    series: PlotSeries[];
    lines: LineDrawing[];
    markers?: ShapeMarker[];
    warnings: string[];
};

export type IndicatorPreset = {
    id: string;
    label: string;
    description: string;
    sourcePath: string;
    warmupBars?: number;
};
