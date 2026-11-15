import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { KpiPoint, TimeSeriesPoint } from "@/types";
import { currency } from "@/lib/format";

const axisProps = {
  stroke: "hsl(var(--muted-foreground))",
  fontSize: 11,
  tickLine: false,
  axisLine: false,
} as const;

const gridProps = {
  stroke: "hsl(var(--border))",
  strokeDasharray: "3 3",
  vertical: false,
} as const;

function TooltipBox({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number | string; color?: string }[];
  label?: string;
  formatter?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-popover-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-popover-foreground">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="flex items-center gap-2 text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="capitalize">{p.name}</span>
          <span className="ml-auto tabular font-medium text-popover-foreground">
            {formatter && typeof p.value === "number" ? formatter(p.value) : p.value}
          </span>
        </p>
      ))}
    </div>
  );
}

export function ExecutionsChart({ data, height = 260 }: { data: TimeSeriesPoint[]; height?: number }) {
  return (
    <div style={{ height }} className="w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="gradAllowed" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.22} />
              <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={52} tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))} />
          <Tooltip content={<TooltipBox />} cursor={{ stroke: "hsl(var(--border))" }} />
          <Area
            type="monotone"
            dataKey="allowed"
            name="Allowed"
            stroke="hsl(var(--primary))"
            strokeWidth={2}
            fill="url(#gradAllowed)"
          />
          <Line type="monotone" dataKey="pending" name="Pending" stroke="hsl(var(--warning))" strokeWidth={1.5} dot={false} />
          <Line type="monotone" dataKey="blocked" name="Blocked" stroke="hsl(var(--danger))" strokeWidth={1.5} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function CostBars({ data, height = 260 }: { data: KpiPoint[]; height?: number }) {
  return (
    <div style={{ height }} className="w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid {...gridProps} horizontal={false} vertical />
          <XAxis type="number" {...axisProps} tickFormatter={(v: number) => currency(v, 0)} />
          <YAxis type="category" dataKey="label" {...axisProps} width={120} />
          <Tooltip content={<TooltipBox formatter={(v) => currency(v)} />} cursor={{ fill: "hsl(var(--muted))" }} />
          <Bar dataKey="value" name="Cost" radius={[0, 6, 6, 0]} barSize={16}>
            {data.map((_, i) => (
              <Cell key={i} fill="hsl(var(--primary))"
                fillOpacity={1 - i * 0.14} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendLine({
  data,
  height = 220,
  color = "hsl(var(--chart-2))",
  suffix = "%",
  domain,
}: {
  data: KpiPoint[];
  height?: number;
  color?: string;
  suffix?: string;
  domain?: [number, number];
}) {
  return (
    <div style={{ height }} className="w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={52} domain={domain} tickFormatter={(v: number) => `${v}${suffix}`} />
          <Tooltip content={<TooltipBox formatter={(v) => `${v}${suffix}`} />} />
          <Line type="monotone" dataKey="value" name="Valeur" stroke={color} strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function StackedBars({ data, height = 260 }: { data: TimeSeriesPoint[]; height?: number }) {
  return (
    <div style={{ height }} className="w-full px-2 pb-2 pt-4">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={52} tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : String(v))} />
          <Tooltip content={<TooltipBox />} cursor={{ fill: "hsl(var(--muted))" }} />
          <Bar dataKey="allowed" name="Allowed" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 0, 0]} barSize={26} />
          <Bar dataKey="pending" name="Pending" stackId="a" fill="hsl(var(--warning))" barSize={26} />
          <Bar dataKey="blocked" name="Blocked" stackId="a" fill="hsl(var(--danger))" radius={[4, 4, 0, 0]} barSize={26} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
