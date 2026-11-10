import StoreKit

enum LifetimeStore {
  enum StoreFailure: Error { case productUnavailable, transactionUnavailable }

  static func product(_ productID: String) async throws -> Product? {
    try await Product.products(for: [productID]).first {
      $0.id == productID && $0.type == .nonConsumable
    }
  }

  static func valid(_ transaction: Transaction, for productID: String) -> Bool {
    transaction.productID == productID && transaction.productType == .nonConsumable
      && transaction.revocationDate == nil
  }

  static func entitlement(_ productID: String) async -> String {
    var unverified = false
    for await result in Transaction.currentEntitlements {
      switch result {
      case .verified(let transaction) where valid(transaction, for: productID):
        return "pro"
      case .unverified(let transaction, _) where transaction.productID == productID:
        unverified = true
      default:
        break
      }
    }
    return unverified ? "unverified" : "free"
  }

  @MainActor
  static func purchase(_ productID: String) async throws -> String {
    guard AppStore.canMakePayments, let item = try await product(productID) else {
      throw StoreFailure.productUnavailable
    }
    let result: Product.PurchaseResult
    do {
      result = try await item.purchase()
    } catch StoreKitError.userCancelled {
      return "cancelled"
    }
    switch result {
    case .success(.verified(let transaction)):
      return valid(transaction, for: productID) ? "verified" : "unverified"
    case .success(.unverified):
      return "unverified"
    case .pending:
      return "pending"
    case .userCancelled:
      return "cancelled"
    @unknown default:
      throw StoreFailure.transactionUnavailable
    }
  }

  static func unfinished(_ productID: String) async -> [String] {
    var ids: [String] = []
    for await result in Transaction.unfinished {
      if case .verified(let transaction) = result, valid(transaction, for: productID) {
        ids.append(String(transaction.id))
      }
    }
    return ids
  }

  static func finish(_ productID: String, _ id: String) async {
    for await result in Transaction.unfinished {
      if case .verified(let transaction) = result, valid(transaction, for: productID), String(transaction.id) == id {
        await transaction.finish()
        return
      }
    }
    // StoreKit may already have removed this transaction from its unfinished queue.
  }
}
