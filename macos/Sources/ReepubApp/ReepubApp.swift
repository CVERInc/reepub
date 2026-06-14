import SwiftUI
import Signet

@main
struct ReepubApp: App {
    @StateObject private var loc = Localizer()

    var body: some Scene {
        WindowGroup("Reepub") {
            ContentView(loc: loc)
                .environmentObject(loc)
                .cverTheme(ReefTheme())
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }
}
