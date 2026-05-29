import SwiftUI

@main
struct ReepubApp: App {
    var body: some Scene {
        WindowGroup("Reepub") {
            ContentView()
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }
}
