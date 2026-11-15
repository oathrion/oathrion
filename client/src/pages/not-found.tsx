import { Link } from "wouter";
import { Compass } from "lucide-react";
import { EmptyState, Surface } from "@/components/common/primitives";

export default function NotFound() {
  return (
    <Surface>
      <EmptyState
        icon={Compass}
        title="Page not found"
        description="This page does not exist in the console."
        action={
          <Link
            href="/dashboard"
            data-testid="link-back-dashboard"
            className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Back to the dashboard
          </Link>
        }
      />
    </Surface>
  );
}
