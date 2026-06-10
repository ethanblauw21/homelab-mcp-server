declare module "vitest" {
  export interface ProvidedContext {
    dockerAvailable: boolean;
    sshKeyPath: string;
    sshHost: string;
    sshPort: number;
  }
}
