export class ProviderSpendLimitError extends Error {
  constructor(message = "provider spend limit reached") {
    super(message);
    this.name = "ProviderSpendLimitError";
  }
}

export class RunSpendLimitError extends Error {
  constructor(message = "run spend cap would be exceeded") {
    super(message);
    this.name = "RunSpendLimitError";
  }
}
