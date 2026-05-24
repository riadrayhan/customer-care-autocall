package com.example.autocall_client

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.annotation.NonNull
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.EventChannel
import java.util.concurrent.Executor

/**
 * Hosts a method/event channel pair used by the Flutter "SIM Dialer" screen
 * to place real cellular calls on this device's SIM and listen to phone state.
 *
 * Channels:
 *   autocall/sim_dialer         (MethodChannel — Dart → Native)
 *   autocall/sim_dialer_events  (EventChannel  — Native → Dart phone-state stream)
 */
class MainActivity : FlutterActivity() {

    companion object {
        private const val METHOD_CHANNEL = "autocall/sim_dialer"
        private const val EVENT_CHANNEL  = "autocall/sim_dialer_events"
    }

    private var eventSink: EventChannel.EventSink? = null
    private var telephonyManager: TelephonyManager? = null
    private var legacyListener: PhoneStateListener? = null
    private var modernCallback: Any? = null
    private var listenerRegistered = false
    private var lastState: Int = TelephonyManager.CALL_STATE_IDLE

    override fun configureFlutterEngine(@NonNull flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        telephonyManager = getSystemService(TELEPHONY_SERVICE) as TelephonyManager

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, METHOD_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "dial" -> {
                        val phone = call.argument<String>("phoneNumber")
                        if (phone.isNullOrBlank()) {
                            result.error("bad_args", "phoneNumber required", null)
                            return@setMethodCallHandler
                        }
                        try {
                            placeCall(phone)
                            result.success(true)
                        } catch (e: SecurityException) {
                            result.error("permission_denied", e.message, null)
                        } catch (e: Exception) {
                            result.error("dial_failed", e.message, null)
                        }
                    }
                    "endCall" -> {
                        // Programmatic hangup requires being the default dialer
                        // on modern Android. Return false to signal limited support.
                        result.success(false)
                    }
                    "hasCallPermission" -> {
                        val granted = ContextCompat.checkSelfPermission(
                            this, Manifest.permission.CALL_PHONE
                        ) == PackageManager.PERMISSION_GRANTED &&
                        ContextCompat.checkSelfPermission(
                            this, Manifest.permission.READ_PHONE_STATE
                        ) == PackageManager.PERMISSION_GRANTED
                        result.success(granted)
                    }
                    "startListening" -> {
                        registerPhoneStateListener()
                        result.success(true)
                    }
                    "stopListening" -> {
                        unregisterPhoneStateListener()
                        result.success(true)
                    }
                    else -> result.notImplemented()
                }
            }

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, EVENT_CHANNEL)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                }
                override fun onCancel(arguments: Any?) {
                    eventSink = null
                }
            })
    }

    private fun placeCall(phoneNumber: String) {
        val intent = Intent(Intent.ACTION_CALL).apply {
            data = Uri.parse("tel:" + Uri.encode(phoneNumber))
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        startActivity(intent)
    }

    private fun emitState(state: String) {
        runOnUiThread { eventSink?.success(mapOf("state" to state)) }
    }

    private fun mapState(s: Int): String = when (s) {
        TelephonyManager.CALL_STATE_IDLE    -> "idle"
        TelephonyManager.CALL_STATE_RINGING -> "ringing"
        TelephonyManager.CALL_STATE_OFFHOOK -> "offhook"
        else -> "unknown"
    }

    private fun registerPhoneStateListener() {
        if (listenerRegistered) return
        val tm = telephonyManager ?: return

        val hasPerm = ContextCompat.checkSelfPermission(
            this, Manifest.permission.READ_PHONE_STATE
        ) == PackageManager.PERMISSION_GRANTED
        if (!hasPerm) {
            emitState("permission_missing")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val executor: Executor = mainExecutor
            val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
                override fun onCallStateChanged(state: Int) {
                    if (state != lastState) {
                        lastState = state
                        emitState(mapState(state))
                    }
                }
            }
            tm.registerTelephonyCallback(executor, cb)
            modernCallback = cb
        } else {
            @Suppress("DEPRECATION")
            val listener = object : PhoneStateListener() {
                override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                    if (state != lastState) {
                        lastState = state
                        emitState(mapState(state))
                    }
                }
            }
            @Suppress("DEPRECATION")
            tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
            legacyListener = listener
        }
        listenerRegistered = true
    }

    private fun unregisterPhoneStateListener() {
        val tm = telephonyManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (modernCallback as? TelephonyCallback)?.let { tm.unregisterTelephonyCallback(it) }
            modernCallback = null
        } else {
            @Suppress("DEPRECATION")
            legacyListener?.let { tm.listen(it, PhoneStateListener.LISTEN_NONE) }
            legacyListener = null
        }
        listenerRegistered = false
    }

    override fun onDestroy() {
        unregisterPhoneStateListener()
        super.onDestroy()
    }
}
