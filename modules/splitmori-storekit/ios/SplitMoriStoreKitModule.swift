import ExpoModulesCore
import StoreKit

public final class SplitMoriStoreKitModule: Module {
  private var listener: Task<Void, Never>?

  public func definition() -> ModuleDefinition {
    Name("SplitMoriStoreKit")
    Events("transactionChanged")

    OnStartObserving("transactionChanged") {
      listener?.cancel()
      listener = Task { [weak self] in
        for await result in Transaction.updates {
          if Task.isCancelled { break }
          switch result {
          case .verified(let transaction):
            self?.sendEvent("transactionChanged", [
              "productId": transaction.productID,
              "revoked": transaction.revocationDate != nil,
            ])
          case .unverified(let transaction, _):
            self?.sendEvent("transactionChanged", ["productId": transaction.productID, "revoked": false])
          }
        }
      }
    }
    OnStopObserving("transactionChanged") {
      listener?.cancel()
      listener = nil
    }
    OnDestroy {
      listener?.cancel()
    }

    AsyncFunction("getProduct") { (productID: String) async throws -> String? in
      try await LifetimeStore.product(productID)?.displayPrice
    }
    AsyncFunction("readEntitlement") { (productID: String) async -> String in
      await LifetimeStore.entitlement(productID)
    }
    AsyncFunction("purchase") { (productID: String) async throws -> String in
      try await LifetimeStore.purchase(productID)
    }
    AsyncFunction("syncPurchases") { () async throws in
      try await AppStore.sync()
    }
    AsyncFunction("unfinished") { (productID: String) async -> [String] in
      await LifetimeStore.unfinished(productID)
    }
    AsyncFunction("finish") { (productID: String, id: String) async in
      await LifetimeStore.finish(productID, id)
    }
  }
}
