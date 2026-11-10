import ExpoModulesCore
import UIKit

public final class SplitMoriDocumentShareModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SplitMoriDocumentShare")

    AsyncFunction("share") { (url: URL, title: String, promise: Promise) in
      guard url.isFileURL, ["pdf", "csv"].contains(url.pathExtension.lowercased()),
        FileSystemUtilities.isReadableFile(appContext, url) else {
        promise.reject("DOCUMENT_UNREADABLE", "The export file is unavailable.")
        return
      }
      guard let presenter = appContext?.utilities?.currentViewController(), presenter.viewIfLoaded?.window != nil,
        presenter.presentedViewController == nil, !presenter.isBeingDismissed else {
        promise.reject("SHARE_UNAVAILABLE", "The share sheet could not be presented.")
        return
      }

      let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      sheet.title = title
      if let popover = sheet.popoverPresentationController {
        popover.sourceView = presenter.view
        let bounds = presenter.view.bounds
        popover.sourceRect = CGRect(x: bounds.midX, y: bounds.midY, width: 1, height: 1)
        popover.permittedArrowDirections = []
      }
      sheet.completionWithItemsHandler = { _, completed, _, error in
        if error != nil {
          promise.reject("SHARE_FAILED", "The selected share action failed.")
        } else {
          promise.resolve(completed ? "completed" : "cancelled")
        }
      }
      presenter.present(sheet, animated: true)
    }
    .runOnQueue(.main)
  }
}
