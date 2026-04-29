//
//  Generated file. Do not edit.
//

// clang-format off

#import "GeneratedPluginRegistrant.h"

#if __has_include(<flutter_callkit_incoming/FlutterCallkitIncomingPlugin.h>)
#import <flutter_callkit_incoming/FlutterCallkitIncomingPlugin.h>
#else
@import flutter_callkit_incoming;
#endif

#if __has_include(<flutter_webrtc/FlutterWebRTCPlugin.h>)
#import <flutter_webrtc/FlutterWebRTCPlugin.h>
#else
@import flutter_webrtc;
#endif

#if __has_include(<permission_handler_apple/PermissionHandlerPlugin.h>)
#import <permission_handler_apple/PermissionHandlerPlugin.h>
#else
@import permission_handler_apple;
#endif

#if __has_include(<shared_preferences_foundation/SharedPreferencesPlugin.h>)
#import <shared_preferences_foundation/SharedPreferencesPlugin.h>
#else
@import shared_preferences_foundation;
#endif

@implementation GeneratedPluginRegistrant

+ (void)registerWithRegistry:(NSObject<FlutterPluginRegistry>*)registry {
  [FlutterCallkitIncomingPlugin registerWithRegistrar:[registry registrarForPlugin:@"FlutterCallkitIncomingPlugin"]];
  [FlutterWebRTCPlugin registerWithRegistrar:[registry registrarForPlugin:@"FlutterWebRTCPlugin"]];
  [PermissionHandlerPlugin registerWithRegistrar:[registry registrarForPlugin:@"PermissionHandlerPlugin"]];
  [SharedPreferencesPlugin registerWithRegistrar:[registry registrarForPlugin:@"SharedPreferencesPlugin"]];
}

@end
