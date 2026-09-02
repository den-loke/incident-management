import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";

export function LoginScreen() {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CardTitle className="text-lg">Incident Status</CardTitle>
          <CardDescription>Restricted to our Slack workspace.</CardDescription>
        </CardHeader>
        <CardContent className="flex justify-center">
          <a className={buttonVariants()} href="/auth/login">
            Sign in with Slack
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
