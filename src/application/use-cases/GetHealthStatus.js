export class GetHealthStatus {
  constructor({
    databaseStatusProvider,
    version,
    dateProvider = () => new Date(),
  }) {
    this.databaseStatusProvider = databaseStatusProvider;
    this.version = version;
    this.dateProvider = dateProvider;
  }

  async execute() {
    try {
      const databaseStatus = await this.databaseStatusProvider.getStatus();

      return {
        ...databaseStatus,
        timestamp: this.dateProvider().toISOString(),
        version: this.version,
      };
    } catch (error) {
      return {
        ok: false,
        database: 'error',
        message: error.message,
      };
    }
  }
}

export default GetHealthStatus;

